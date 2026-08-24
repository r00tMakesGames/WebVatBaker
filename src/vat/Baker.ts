import * as THREE from 'three';
import type { BaseCharacter } from './FBXImporter';
import { AnimationSampler } from './AnimationSampler';
import { SkinEvaluator, makeEvalTarget } from './SkinEvaluator';
import { BoneEvaluator, packInfluences } from './BoneEvaluator';
import { frameTime, reindex, toRanges } from './AnimationLibrary';
import {
  buildLookupTexture,
  computeLayout,
  finalizeBounds,
  makeBoundsAccumulator,
} from './VATPacker';
import type {
  BakeProgressInfo,
  BakeResult,
  BoneBakeData,
  VATAnimation,
} from './types';
import type { BakeSettings } from './types';

export class BakeCancelled extends Error {
  constructor() {
    super('Bake cancelled.');
  }
}

export interface CancellationToken {
  cancelled: boolean;
}

export interface BakeInput {
  character: BaseCharacter;
  sampler: AnimationSampler;
  evaluator: SkinEvaluator;
  animations: VATAnimation[];
  settings: BakeSettings;
}

const YIELD_BUDGET_MS = 14;

/**
 * Bone mode verifies itself against the vertex path by fully skinning a subset
 * of frames. Every frame is checked on short bakes; long bakes stride so the
 * check stays a check rather than becoming the bake.
 */
const BONE_VERIFY_TARGET_FRAMES = 200;

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Bake every animation, in list order, into one linear VAT atlas.
 *
 * The loop is cooperative rather than worker-based: FBXLoader, AnimationMixer
 * and Skeleton all live on the main thread and are not structured-cloneable, so
 * moving the bake off-thread would mean re-parsing the FBX inside the worker.
 * Instead the loop yields to the event loop roughly every 14 ms, which keeps the
 * UI responsive and makes cancellation immediate.
 */
export async function bakeVAT(
  input: BakeInput,
  onProgress: (info: BakeProgressInfo) => void,
  token: CancellationToken,
): Promise<BakeResult> {
  const started = performance.now();
  const { sampler, evaluator, animations, settings } = input;
  const boneMode = settings.vatMode === 'bone';

  const vertexCount = evaluator.vertexCount;
  const totalFrames = reindex(animations, settings.bakeFPS);
  if (totalFrames <= 0) throw new Error('Nothing to bake: total frame count is 0.');

  evaluator.setUnitScale(settings.unitScale);

  const boneEval = boneMode ? new BoneEvaluator(evaluator, input.character.mesh) : null;

  // In bone mode the texture is addressed by bone, not by vertex, which is the
  // entire reason the output is small.
  const addressedCount = boneMode ? boneEval!.boneCount : vertexCount;
  const layout = computeLayout(
    addressedCount,
    totalFrames,
    settings.textureWidth,
    settings.maxTextureDimension,
  );

  const texels = layout.width * layout.height * 4;
  const positions = new Float32Array(texels);
  // Bone mode rotates the rest normal by the same blended quaternion at runtime,
  // so a normal texture would be redundant data.
  const normals = !boneMode && settings.bakeNormals ? new Float32Array(texels) : null;
  const rotations = boneMode ? new Float32Array(texels) : null;

  // ---- rest pose ----------------------------------------------------------
  onProgress({
    phase: 'rest',
    animationIndex: 0,
    animationCount: animations.length,
    animationName: 'Rest pose',
    frame: 0,
    frameCount: 1,
    globalFrame: 0,
    totalFrames,
    percent: 0,
  });

  const restPositions = new Float32Array(vertexCount * 3);
  const restNormals = new Float32Array(vertexCount * 3);

  sampler.setClip(null);
  sampler.restPose();
  evaluator.updateBoneMatrices();

  const target = makeEvalTarget();
  target.positions = restPositions;
  target.positionBase = 0;
  target.positionStride = 3;
  target.normals = restNormals;
  target.normalBase = 0;
  target.normalStride = 3;
  target.bounds = null;
  let nanCount = evaluator.evaluate(target);

  // How far the skinned rest pose drifts from the raw bind-pose geometry. In
  // vertex mode this is a diagnostic; in bone mode it is the error bound on the
  // whole bake, because B_k = M_k * F^-1 assumes rest == bind.
  const restDeviation = evaluator.restDeviation(restPositions);

  boneEval?.captureRest();

  // ---- animation frames ---------------------------------------------------
  const absBounds = makeBoundsAccumulator();
  const storedBounds = makeBoundsAccumulator();
  const boneBounds = boneMode ? makeBoundsAccumulator() : null;
  const offsetMode = settings.positionMode === 'offset';

  // Scratch buffers for bone-mode self-verification.
  const packedInfluences = boneMode
    ? packInfluences(evaluator.skinIndexArray, evaluator.skinWeightArray, vertexCount)
    : null;
  const reference = boneMode ? new Float32Array(vertexCount * 3) : null;
  const reconstructed = boneMode ? new Float32Array(vertexCount * 3) : null;
  const verifyStride = boneMode
    ? Math.max(1, Math.ceil(totalFrames / BONE_VERIFY_TARGET_FRAMES))
    : 1;
  let maxReconstructionError = 0;

  if (!boneMode) {
    target.positions = positions;
    target.positionStride = 4;
    target.normals = normals;
    target.normalStride = 4;
    target.bounds = absBounds;
  } else {
    target.positions = reference!;
    target.positionStride = 3;
    target.normals = null;
    target.bounds = absBounds;
  }

  const boneTarget = boneMode
    ? { positions, rotations: rotations!, base: 0, bounds: boneBounds }
    : null;

  let lastYield = performance.now();
  let done = 0;

  for (let ai = 0; ai < animations.length; ai++) {
    const anim = animations[ai];
    sampler.setClip(anim.clip);

    for (let f = 0; f < anim.frameCount; f++) {
      if (token.cancelled) throw new BakeCancelled();

      const globalFrame = anim.startFrame + f;
      const t = frameTime(f, settings.bakeFPS, anim.duration);

      sampler.sample(t);
      evaluator.updateBoneMatrices();

      if (boneMode) {
        const base = globalFrame * addressedCount * 4;
        boneTarget!.base = base;
        boneEval!.evaluate(boneTarget!);

        // Skin the reference on a strided subset: gives animated bounds on those
        // frames and, more importantly, a hard number for how far the bone
        // reconstruction drifts from ground truth.
        if (globalFrame % verifyStride === 0) {
          nanCount += evaluator.evaluate(target);
          boneEval!.skinFrameCPU(
            restPositions,
            packedInfluences!,
            positions,
            rotations!,
            base,
            reconstructed!,
          );
          const ref = reference!;
          const rec = reconstructed!;
          for (let i = 0; i < vertexCount; i++) {
            const p3 = i * 3;
            const dx = rec[p3] - ref[p3];
            const dy = rec[p3 + 1] - ref[p3 + 1];
            const dz = rec[p3 + 2] - ref[p3 + 2];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > maxReconstructionError) maxReconstructionError = d;
          }
        }
      } else {
        const base = globalFrame * vertexCount * 4;
        target.positionBase = base;
        target.normalBase = base;
        nanCount += evaluator.evaluate(target);

        // Convert to offsets and stamp alpha. Cheap compared to skinning.
        let sMinX = storedBounds[0], sMinY = storedBounds[1], sMinZ = storedBounds[2];
        let sMaxX = storedBounds[3], sMaxY = storedBounds[4], sMaxZ = storedBounds[5];
        for (let v = 0; v < vertexCount; v++) {
          const o = base + v * 4;
          if (offsetMode) {
            const r = v * 3;
            positions[o] -= restPositions[r];
            positions[o + 1] -= restPositions[r + 1];
            positions[o + 2] -= restPositions[r + 2];
          }
          positions[o + 3] = 1;
          if (normals) normals[o + 3] = 1;
          const x = positions[o], y = positions[o + 1], z = positions[o + 2];
          if (x < sMinX) sMinX = x;
          if (y < sMinY) sMinY = y;
          if (z < sMinZ) sMinZ = z;
          if (x > sMaxX) sMaxX = x;
          if (y > sMaxY) sMaxY = y;
          if (z > sMaxZ) sMaxZ = z;
        }
        storedBounds[0] = sMinX; storedBounds[1] = sMinY; storedBounds[2] = sMinZ;
        storedBounds[3] = sMaxX; storedBounds[4] = sMaxY; storedBounds[5] = sMaxZ;
      }

      done++;

      const now = performance.now();
      if (now - lastYield > YIELD_BUDGET_MS) {
        lastYield = now;
        onProgress({
          phase: 'sampling',
          animationIndex: ai,
          animationCount: animations.length,
          animationName: anim.name,
          frame: f + 1,
          frameCount: anim.frameCount,
          globalFrame,
          totalFrames,
          percent: (done / totalFrames) * 100,
        });
        await nextTask();
      }
    }
  }

  sampler.setClip(null);
  sampler.restPose();

  onProgress({
    phase: 'packing',
    animationIndex: animations.length,
    animationCount: animations.length,
    animationName: 'Packing',
    frame: totalFrames,
    frameCount: totalFrames,
    globalFrame: totalFrames - 1,
    totalFrames,
    percent: 100,
  });
  await nextTask();

  const ranges = toRanges(animations);
  const lookupTexture = settings.generateLookupTexture ? buildLookupTexture(ranges) : null;

  let bone: BoneBakeData | null = null;
  if (boneMode) {
    nanCount += boneEval!.nanCount;
    bone = {
      layout,
      positions,
      rotations: rotations!,
      boneCount: boneEval!.boneCount,
      boneNames: boneEval!.boneNames,
      packedInfluences: packedInfluences!,
      bounds: finalizeBounds(boneBounds!),
      maxScaleDeviation: boneEval!.maxScaleDeviation,
      maxReconstructionError,
    };
    // The bone textures are already rest-relative, so stored range == bone range.
    storedBounds.set(boneBounds!);
  }

  return {
    layout,
    positions,
    normals,
    restPositions,
    restNormals,
    vertexCount,
    totalFrames,
    bounds: finalizeBounds(absBounds),
    storedBounds: finalizeBounds(storedBounds),
    ranges,
    settings: { ...settings },
    nanCount,
    restDeviation,
    durationMs: performance.now() - started,
    lookupTexture,
    bone,
  };
}

/** Rough memory estimate shown before the user commits to a bake. */
export function estimateBakeMemory(
  vertexCount: number,
  totalFrames: number,
  bakeNormals: boolean,
  boneCount = 0,
): number {
  if (boneCount > 0) {
    // position + rotation textures, plus the vertex-sized verification scratch
    return boneCount * totalFrames * 4 * 4 * 2 + vertexCount * 3 * 4 * 3;
  }
  const samples = vertexCount * totalFrames * 4 * 4; // RGBA float32
  return bakeNormals ? samples * 2 : samples;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

/** Helper used by the preview: build a Three texture over a baked buffer. */
export function makeDataTexture(
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  // TypeScript 5.7 made TypedArrays generic over their backing buffer, so a
  // plain `Float32Array` widens to `Float32Array<ArrayBufferLike>` and no longer
  // matches the DOM's `BufferSource` (`ArrayBufferView<ArrayBuffer>`), which is
  // what DataTexture asks for. These arrays are always ArrayBuffer-backed — we
  // allocate them ourselves and never touch SharedArrayBuffer — so the cast
  // states a fact the compiler lost rather than papering over a real mismatch.
  // Doing it here keeps the project compiling on both TS 5.6 and 5.7+ instead of
  // pinning the toolchain to an old version.
  const tex = new THREE.DataTexture(
    data as unknown as BufferSource,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

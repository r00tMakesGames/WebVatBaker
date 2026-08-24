import * as THREE from 'three';
import type { SkinEvaluator } from './SkinEvaluator';

/**
 * Bone-based VAT: store one transform per BONE per frame instead of one position
 * per VERTEX per frame, and re-do the skinning at runtime in the material.
 *
 * ---------------------------------------------------------------------------
 * The math, and why it is exact
 * ---------------------------------------------------------------------------
 *
 * SkinEvaluator folds each bone's full transform into VAT object space as
 *
 *   M_k = S * meshWorld * bindMatrixInverse * (boneWorld_k * boneInverse_k) * bindMatrix
 *
 * and skins a raw geometry vertex p with  P_anim = sum_k w_k * M_k * p.
 *
 * The exported static mesh does not store p; it stores the skinned REST position
 * P_rest. So we cannot ship M_k directly — the shader has the wrong input. What
 * we ship instead is the bone's transform relative to its own rest transform:
 *
 *   B_k = M_k * F^-1        where F is M_k evaluated at the rest pose
 *
 * At the BIND pose every bone satisfies boneWorld_k * boneInverse_k = I, so
 *
 *   M_rest_k = S * meshWorld * bindMatrixInverse * I * bindMatrix = F
 *
 * — the same matrix for every bone, which is exactly SkinEvaluator's zero-weight
 * fallback. Therefore M_rest_k * p = F * p = P_rest for every influencing bone,
 * and the skin identity survives the substitution intact:
 *
 *   P_anim = sum_k w_k * M_k * p
 *          = sum_k w_k * B_k * (F * p)
 *          = sum_k w_k * B_k * P_rest
 *
 * which is precisely what the runtime shader evaluates. Note the condition: this
 * is exact only when the rest pose IS the bind pose. That is what
 * SkinEvaluator.restDeviation() measures, so a non-zero deviation is not a
 * cosmetic warning in bone mode — it is the error bound on every frame, and the
 * baker escalates it accordingly.
 *
 * B_k is then decomposed into translation + rotation. Scale is discarded: a
 * quaternion cannot carry it, and squash-and-stretch rigs are the one case bone
 * VAT genuinely cannot represent. The largest scale deviation seen across the
 * whole bake is reported so the user finds out rather than guessing.
 *
 * At rest B_k = I, so the stored translation is naturally zero-centred and the
 * stored quaternion is identity — no separate "offset mode" is needed, and
 * RGBA16F is comfortable for both.
 */

export interface BoneBakeTarget {
  /** RGBA buffer, translation in XYZ */
  positions: Float32Array;
  /** RGBA buffer, quaternion in XYZW */
  rotations: Float32Array;
  /** sample offset for this frame, in floats */
  base: number;
  /** [minX,minY,minZ,maxX,maxY,maxZ] accumulator, or null */
  bounds: Float32Array | null;
}

export class BoneEvaluator {
  readonly boneCount: number;
  readonly boneNames: string[];

  /** Largest |scale - 1| seen on any bone on any frame. */
  maxScaleDeviation = 0;
  /** Count of non-finite components written. */
  nanCount = 0;

  private readonly restInverse = new THREE.Matrix4();
  private readonly delta = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  /** previous frame's quaternion per bone, for hemisphere continuity */
  private readonly prevQuat: Float32Array;
  private hasPrev = false;

  constructor(
    private readonly skin: SkinEvaluator,
    private readonly mesh: THREE.SkinnedMesh,
  ) {
    this.boneCount = mesh.skeleton.bones.length;
    this.boneNames = mesh.skeleton.bones.map((b) => b.name);
    this.prevQuat = new Float32Array(this.boneCount * 4);
  }

  /**
   * Capture the rest-pose reference matrix. Must be called while the skeleton is
   * in its rest pose and after SkinEvaluator.updateBoneMatrices().
   */
  captureRest(): void {
    this.restInverse.fromArray(this.skin.fallbackMatrix).invert();
    this.hasPrev = false;
    this.maxScaleDeviation = 0;
    this.nanCount = 0;
  }

  /**
   * Write one frame of bone transforms. Requires
   * SkinEvaluator.updateBoneMatrices() to have run for the current pose.
   */
  evaluate(target: BoneBakeTarget): void {
    const bm = this.skin.boneMatrixArray;
    const outP = target.positions;
    const outR = target.rotations;
    const base = target.base;
    const bounds = target.bounds;
    const prev = this.prevQuat;

    let minX = bounds ? bounds[0] : 0;
    let minY = bounds ? bounds[1] : 0;
    let minZ = bounds ? bounds[2] : 0;
    let maxX = bounds ? bounds[3] : 0;
    let maxY = bounds ? bounds[4] : 0;
    let maxZ = bounds ? bounds[5] : 0;

    for (let b = 0; b < this.boneCount; b++) {
      this.delta.fromArray(bm, b * 16).multiply(this.restInverse);
      this.delta.decompose(this.pos, this.quat, this.scale);

      const sd = Math.max(
        Math.abs(this.scale.x - 1),
        Math.abs(this.scale.y - 1),
        Math.abs(this.scale.z - 1),
      );
      if (sd > this.maxScaleDeviation) this.maxScaleDeviation = sd;

      let qx = this.quat.x, qy = this.quat.y, qz = this.quat.z, qw = this.quat.w;

      // A quaternion and its negation describe the same rotation, but decompose()
      // can hand back either one. Interpolating across a sign flip sends the bone
      // the long way round the sphere, which reads as a single-frame spin. Keep
      // every bone in the same hemisphere as the previous frame.
      const p4 = b * 4;
      if (this.hasPrev) {
        const dot = qx * prev[p4] + qy * prev[p4 + 1] + qz * prev[p4 + 2] + qw * prev[p4 + 3];
        if (dot < 0) {
          qx = -qx; qy = -qy; qz = -qz; qw = -qw;
        }
      }
      prev[p4] = qx; prev[p4 + 1] = qy; prev[p4 + 2] = qz; prev[p4 + 3] = qw;

      const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
      if (px !== px || py !== py || pz !== pz) this.nanCount++;
      if (qx !== qx || qy !== qy || qz !== qz || qw !== qw) this.nanCount++;

      const o = base + b * 4;
      outP[o] = px; outP[o + 1] = py; outP[o + 2] = pz; outP[o + 3] = 1;
      outR[o] = qx; outR[o + 1] = qy; outR[o + 2] = qz; outR[o + 3] = qw;

      if (bounds) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
      }
    }

    this.hasPrev = true;

    if (bounds) {
      bounds[0] = minX; bounds[1] = minY; bounds[2] = minZ;
      bounds[3] = maxX; bounds[4] = maxY; bounds[5] = maxZ;
    }
  }

  /**
   * Skin the rest positions with a baked frame on the CPU, using exactly the
   * arithmetic the runtime shader performs. Used by the validation pass to prove
   * the bone path reproduces the vertex path before anything is exported.
   */
  skinFrameCPU(
    restPositions: Float32Array,
    packedInfluences: Float32Array,
    positions: Float32Array,
    rotations: Float32Array,
    base: number,
    out: Float32Array,
  ): void {
    const vc = restPositions.length / 3;
    for (let v = 0; v < vc; v++) {
      const p3 = v * 3;
      const rx = restPositions[p3], ry = restPositions[p3 + 1], rz = restPositions[p3 + 2];
      let ax = 0, ay = 0, az = 0, wsum = 0;

      for (let k = 0; k < 4; k++) {
        const packed = packedInfluences[v * 4 + k];
        const bone = Math.floor(packed);
        const w = (packed - bone) / WEIGHT_SCALE;
        if (w <= 0) continue;
        wsum += w;

        const o = base + bone * 4;
        const qx = rotations[o], qy = rotations[o + 1], qz = rotations[o + 2], qw = rotations[o + 3];

        // v' = v + 2q_v x (q_v x v + q_w v)
        const tx = 2 * (qy * rz - qz * ry);
        const ty = 2 * (qz * rx - qx * rz);
        const tz = 2 * (qx * ry - qy * rx);
        const sx = rx + qw * tx + (qy * tz - qz * ty);
        const sy = ry + qw * ty + (qz * tx - qx * tz);
        const sz = rz + qw * tz + (qx * ty - qy * tx);

        ax += w * (sx + positions[o]);
        ay += w * (sy + positions[o + 1]);
        az += w * (sz + positions[o + 2]);
      }

      if (wsum > 1e-6) {
        const inv = 1 / wsum;
        ax *= inv; ay *= inv; az *= inv;
      } else {
        ax = rx; ay = ry; az = rz;
      }
      out[p3] = ax; out[p3 + 1] = ay; out[p3 + 2] = az;
    }
  }
}

/**
 * Weight is carried in the fractional part of the same float as the bone index:
 *
 *   packed = boneIndex + weight * 0.99
 *   boneIndex = floor(packed)
 *   weight    = frac(packed) / 0.99
 *
 * 0.99 rather than 1.0 so that weight == 1 cannot carry into the next integer.
 * Four influences then fit in two UV channels instead of four, which matters
 * because GLTFExporter only maps uv/uv1/uv2/uv3. fp32 gives ~14 bits to the
 * fraction after a 10-bit bone index, so weight precision is ~1/16000 — far
 * finer than the 8-bit weights most engines ship. This does make
 * "Use Full Precision UVs" mandatory in bone mode rather than merely advisable.
 */
export const WEIGHT_SCALE = 0.99;

/** Build the per-vertex packed influence array: vertexCount * 4 floats. */
export function packInfluences(
  skinIndex: Uint32Array,
  skinWeight: Float32Array,
  vertexCount: number,
): Float32Array {
  const out = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    const o = v * 4;
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += skinWeight[o + k];
    const inv = sum > 1e-8 ? 1 / sum : 0;
    for (let k = 0; k < 4; k++) {
      const w = Math.min(1, Math.max(0, skinWeight[o + k] * inv));
      out[o + k] = skinIndex[o + k] + w * WEIGHT_SCALE;
    }
  }
  return out;
}

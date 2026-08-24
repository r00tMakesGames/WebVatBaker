import * as THREE from 'three';
import { Store } from './store';
import { playheadStore } from './playhead';
import { downloadBlob } from './download';
import { viewport, type PreviewMode } from '../viewport/Viewport';

import {
  importBaseCharacter,
  importAnimationFBX,
  detectSourceFPS,
  type BaseCharacter,
  type ImportIssue,
} from '../vat/FBXImporter';
import { AnimationSampler } from '../vat/AnimationSampler';
import { SkinEvaluator } from '../vat/SkinEvaluator';
import {
  buildBoneIndex,
  estimateTranslationScale,
  retargetClip,
  type BoneIndex,
} from '../vat/SkeletonMatcher';
import {
  enforceUniqueNames,
  frameTime,
  moveItem,
  reindex,
  resolveGlobalFrame,
} from '../vat/AnimationLibrary';
import { bakeVAT, BakeCancelled, type CancellationToken } from '../vat/Baker';
import {
  buildVATStaticGeometry,
  buildVATMesh,
  exportGLB,
  type StaticMeshBuild,
} from '../vat/MeshExporter';
import { buildMetadata, metadataToCSV, metadataToJSON } from '../vat/VATMetadata';
import { gltfToUnreal, writeEXR } from '../vat/EXRWriter';
import { reportToText, validatePostBake, validatePreBake, type ValidationReport } from '../vat/Validation';
import { assetLeadToken, deriveAnimationName, deriveAssetName, outputNames, splitList } from '../vat/naming';
import type {
  BakeProgressInfo,
  BakeResult,
  BakeSettings,
  MatchOptions,
  NamingOptions,
  VATAnimation,
} from '../vat/types';

export interface LogEntry {
  level: 'error' | 'warning' | 'info';
  message: string;
  at: number;
}

export interface AppState {
  baseLoaded: boolean;
  baseName: string;
  baseSummary: {
    vertexCount: number;
    boneCount: number;
    uvSets: string[];
    triangleCount: number;
    bounds: string;
  } | null;
  animations: VATAnimation[];
  selectedUid: string | null;
  settings: BakeSettings;
  match: MatchOptions;
  naming: NamingOptions;
  log: LogEntry[];
  busy: string | null;
  baking: boolean;
  progress: BakeProgressInfo | null;
  result: BakeResult | null;
  reports: ValidationReport[];
  previewMode: PreviewMode;
  restPose: boolean;
  playing: boolean;
  playbackSpeed: number;
  interpolate: boolean;
  showSkeleton: boolean;
  totalFrames: number;
}

const defaultSettings: BakeSettings = {
  assetName: 'Asset',
  vatMode: 'vertex',
  bakeFPS: 30,
  positionMode: 'offset',
  precision: 'RGBA16F',
  textureWidth: 'auto',
  bakeNormals: false,
  generateLookupTexture: true,
  unitScale: 1,
  lookupSplit: 1024,
  maxTextureDimension: 8192,
  axisConversion: 'none',
};

const defaultMatch: MatchOptions = {
  stripNamespaces: true,
  extraNamespaces: '',
  stripNonRootTranslation: true,
  stripScaleTracks: true,
  translationScaleMode: 'none',
  translationScale: 1,
};

const defaultNaming: NamingOptions = {
  assetPrefixes: 'SK_, SM_, S_',
  animationPrefixes: 'AN_, A_, Anim_, Animation_',
  animationTokens: '',
};

export const appStore = new Store<AppState>({
  baseLoaded: false,
  baseName: '',
  baseSummary: null,
  animations: [],
  selectedUid: null,
  settings: defaultSettings,
  match: defaultMatch,
  naming: defaultNaming,
  log: [],
  busy: null,
  baking: false,
  progress: null,
  result: null,
  reports: [],
  previewMode: 'skeletal',
  restPose: false,
  playing: true,
  playbackSpeed: 1,
  interpolate: true,
  showSkeleton: false,
  totalFrames: 0,
});

// ---- non-serializable session ---------------------------------------------

interface Session {
  character: BaseCharacter | null;
  sampler: AnimationSampler | null;
  evaluator: SkinEvaluator | null;
  boneIndex: BoneIndex | null;
  staticBuild: StaticMeshBuild | null;
  token: CancellationToken | null;
  playTime: number;
  uid: number;
}

const session: Session = {
  character: null,
  sampler: null,
  evaluator: null,
  boneIndex: null,
  staticBuild: null,
  token: null,
  playTime: 0,
  uid: 0,
};

function log(level: LogEntry['level'], message: string) {
  appStore.set((s) => ({
    log: [...s.log.slice(-199), { level, message, at: Date.now() }],
  }));
}

function logIssues(issues: ImportIssue[]) {
  for (const i of issues) log(i.level, i.message);
}

function nextUid(): string {
  session.uid += 1;
  return `a${session.uid}`;
}

export function selectedAnimation(state = appStore.get()): VATAnimation | null {
  if (state.restPose || !state.selectedUid) return null;
  return state.animations.find((a) => a.uid === state.selectedUid) ?? null;
}

// ---- import ----------------------------------------------------------------

export async function loadBaseFile(file: File): Promise<void> {
  appStore.set({ busy: `Reading ${file.name}…` });
  try {
    const buffer = await file.arrayBuffer();
    const { character, issues } = importBaseCharacter(buffer, file.name);
    logIssues(issues);
    if (!character) {
      appStore.set({ busy: null });
      return;
    }

    session.character = character;
    session.sampler = new AnimationSampler(
      character.root,
      character.skeleton.bones,
      character.boneRest,
    );
    session.evaluator = new SkinEvaluator(character.mesh, appStore.get().settings.unitScale);
    session.staticBuild = null;

    const assetName = deriveAssetName(
      file.name,
      splitList(appStore.get().naming.assetPrefixes),
    );
    const maxDim = viewport.maxTextureSize;

    const index = character.mesh.geometry.getIndex();
    const triangleCount = Math.floor(
      (index ? index.count : character.vertexCount) / 3,
    );
    const size = character.bounds.getSize(new THREE.Vector3());

    appStore.set((s) => ({
      baseLoaded: true,
      baseName: file.name,
      baseSummary: {
        vertexCount: character.vertexCount,
        boneCount: character.skeleton.bones.length,
        uvSets: character.uvSets,
        triangleCount,
        bounds: `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)}`,
      },
      settings: {
        ...s.settings,
        assetName,
        maxTextureDimension: Math.min(maxDim, 16384),
      },
      naming: {
        ...s.naming,
        animationTokens: s.naming.animationTokens || assetLeadToken(assetName),
      },
      result: null,
      reports: [],
      previewMode: 'skeletal',
    }));

    session.boneIndex = buildBoneIndex(character.skeleton, appStore.get().match);
    viewport.setCharacter(character.root, character.bounds);
    viewport.setVATPreview(null);
    session.sampler.restPose();

    log(
      'info',
      `Loaded ${file.name}: ${character.vertexCount.toLocaleString()} vertices, ${character.skeleton.bones.length} bones.`,
    );

    // Existing clips must be retargeted against the new skeleton.
    if (appStore.get().animations.length > 0) retargetAll();
  } catch (err) {
    log('error', `Failed to load ${file.name}: ${(err as Error).message}`);
  } finally {
    appStore.set({ busy: null });
  }
}

export async function loadAnimationFiles(files: File[]): Promise<void> {
  if (!session.character || !session.boneIndex) {
    log('error', 'Load the base character before adding animations.');
    return;
  }
  const state = appStore.get();
  const prefixes = splitList(state.naming.animationPrefixes);
  const tokens = splitList(state.naming.animationTokens);
  const added: VATAnimation[] = [];

  for (const file of files) {
    appStore.set({ busy: `Reading ${file.name}…` });
    try {
      const buffer = await file.arrayBuffer();
      const { clips, root, issues } = importAnimationFBX(buffer, file.name);
      logIssues(issues);
      if (clips.length === 0) continue;

      const autoScale = estimateTranslationScale(
        session.character.skeleton,
        root,
        state.match,
      );

      clips.forEach((clip, i) => {
        const result = retargetClip(clip, session.boneIndex!, state.match, autoScale);
        const label = deriveAnimationName(file.name, prefixes, tokens);
        added.push({
          uid: nextUid(),
          id: 0,
          name: clips.length > 1 ? `${label}_${i}` : label,
          sourceFilename: file.name,
          clip: result.clip,
          rawClip: clip,
          duration: result.clip.duration,
          sourceFPS: detectSourceFPS(clip),
          fps: state.settings.bakeFPS,
          loop: true,
          startFrame: 0,
          endFrame: 0,
          frameCount: 0,
          compatibility: result.compatibility,
          compatibilityNote: result.compatibilityNote,
          missingBones: result.missingBones,
          extraBones: result.extraBones,
          matchedBones: result.matchedBones,
          autoTranslationScale: autoScale,
        });
        if (result.compatibility === 'error') {
          log('error', `${file.name}: ${result.compatibilityNote}`);
        } else if (result.compatibility === 'warning') {
          log('warning', `${file.name}: ${result.compatibilityNote}`);
        }
      });
    } catch (err) {
      log('error', `Failed to load ${file.name}: ${(err as Error).message}`);
    }
  }

  if (added.length > 0) {
    const animations = [...appStore.get().animations, ...added];
    enforceUniqueNames(animations);
    commitAnimations(animations, appStore.get().selectedUid ?? added[0].uid);
    log('info', `Added ${added.length} animation(s).`);
  }
  appStore.set({ busy: null });
}

function commitAnimations(animations: VATAnimation[], selectedUid: string | null) {
  const total = reindex(animations, appStore.get().settings.bakeFPS);
  appStore.set({
    animations,
    totalFrames: total,
    selectedUid:
      selectedUid && animations.some((a) => a.uid === selectedUid)
        ? selectedUid
        : (animations[0]?.uid ?? null),
    // Any change to the set invalidates the previous bake.
    result: null,
    reports: [],
  });
  viewport.setVATPreview(null);
  session.staticBuild = null;
  if (appStore.get().previewMode !== 'skeletal') {
    appStore.set({ previewMode: 'skeletal' });
    viewport.setMode('skeletal');
  }
}

export function retargetAll(): void {
  if (!session.character) return;
  const state = appStore.get();
  session.boneIndex = buildBoneIndex(session.character.skeleton, state.match);
  const animations = state.animations.map((a) => {
    const r = retargetClip(a.rawClip, session.boneIndex!, state.match, a.autoTranslationScale);
    return {
      ...a,
      clip: r.clip,
      duration: r.clip.duration,
      compatibility: r.compatibility,
      compatibilityNote: r.compatibilityNote,
      missingBones: r.missingBones,
      extraBones: r.extraBones,
      matchedBones: r.matchedBones,
    };
  });
  session.sampler?.setClip(null);
  commitAnimations(animations, state.selectedUid);
}

// ---- list mutations --------------------------------------------------------

export function reorderAnimation(from: number, to: number): void {
  commitAnimations(moveItem(appStore.get().animations, from, to), appStore.get().selectedUid);
}

export function renameAnimation(uid: string, name: string): void {
  const animations = appStore.get().animations.map((a) =>
    a.uid === uid ? { ...a, name: name.trim() || a.name } : a,
  );
  commitAnimations(animations, appStore.get().selectedUid);
}

export function removeAnimation(uid: string): void {
  commitAnimations(
    appStore.get().animations.filter((a) => a.uid !== uid),
    appStore.get().selectedUid === uid ? null : appStore.get().selectedUid,
  );
}

export function toggleLoop(uid: string): void {
  const animations = appStore.get().animations.map((a) =>
    a.uid === uid ? { ...a, loop: !a.loop } : a,
  );
  commitAnimations(animations, appStore.get().selectedUid);
}

export function selectAnimation(uid: string): void {
  appStore.set({ selectedUid: uid, restPose: false });
  session.playTime = 0;
}

export function clearAnimations(): void {
  commitAnimations([], null);
}

// ---- settings --------------------------------------------------------------

export function updateSettings(patch: Partial<BakeSettings>): void {
  appStore.set((s) => ({ settings: { ...s.settings, ...patch } }));
  if (patch.unitScale !== undefined) session.evaluator?.setUnitScale(patch.unitScale);
  if (patch.bakeFPS !== undefined || patch.lookupSplit !== undefined) {
    commitAnimations(appStore.get().animations, appStore.get().selectedUid);
  }
}

export function updateMatch(patch: Partial<MatchOptions>): void {
  appStore.set((s) => ({ match: { ...s.match, ...patch } }));
  retargetAll();
}

export function updateNaming(patch: Partial<NamingOptions>): void {
  appStore.set((s) => ({ naming: { ...s.naming, ...patch } }));
}

export function setPreviewMode(mode: PreviewMode): void {
  appStore.set({ previewMode: mode });
  viewport.setMode(mode);
}

export function setRestPose(restPose: boolean): void {
  appStore.set({ restPose });
  session.playTime = 0;
  if (restPose) session.sampler?.setClip(null);
}

export function setPlaying(playing: boolean): void {
  appStore.set({ playing });
}

export function scrubTo(localFrame: number): void {
  const anim = selectedAnimation();
  if (!anim) return;
  session.playTime = frameTime(localFrame, anim.fps, anim.duration);
  appStore.set({ playing: false });
}

export function setShowSkeleton(show: boolean): void {
  appStore.set({ showSkeleton: show });
  viewport.setSkeletonVisible(show);
}

// ---- playback --------------------------------------------------------------

viewport.onFrame = (dt) => {
  const state = appStore.get();
  const sampler = session.sampler;
  if (!sampler) return;

  const anim = selectedAnimation(state);
  if (!anim) {
    sampler.setClip(null);
    sampler.restPose();
    playheadStore.set({
      animationId: -1,
      animationName: 'Rest pose',
      localFrame: 0,
      localFrameCount: 0,
      globalFrame: 0,
      totalFrames: state.totalFrames,
      textureX: 0,
      textureY: 0,
      time: 0,
    });
    return;
  }

  if (state.playing) {
    session.playTime += dt * state.playbackSpeed;
    const span = anim.frameCount / anim.fps;
    if (anim.loop) {
      session.playTime = span > 0 ? session.playTime % span : 0;
    } else if (session.playTime > anim.duration) {
      session.playTime = anim.duration;
    }
  }

  const localFrameFloat = Math.min(session.playTime * anim.fps, anim.frameCount - 1);
  const localFrame = Math.max(0, localFrameFloat);
  const time = frameTime(localFrame, anim.fps, anim.duration);

  sampler.setClip(anim.clip);
  sampler.sample(time);

  const globalFrame = anim.startFrame + localFrame;
  viewport.setVATFrame(globalFrame, state.totalFrames, state.interpolate);

  const result = state.result;
  const width = result?.layout.width ?? 0;
  const vertexCount = result?.vertexCount ?? 0;
  const linear = Math.floor(globalFrame) * vertexCount;

  playheadStore.set({
    animationId: anim.id,
    animationName: anim.name,
    localFrame,
    localFrameCount: anim.frameCount,
    globalFrame,
    totalFrames: state.totalFrames,
    textureX: width > 0 ? linear % width : 0,
    textureY: width > 0 ? Math.floor(linear / width) : 0,
    time,
  });
};

// ---- bake ------------------------------------------------------------------

export async function runBake(): Promise<void> {
  const state = appStore.get();
  if (!session.character || !session.sampler || !session.evaluator) {
    log('error', 'No base character loaded.');
    return;
  }

  const pre = validatePreBake(session.character, state.animations, state.settings);
  appStore.set({ reports: [pre] });
  if (!pre.ok) {
    log('error', 'Pre-bake validation failed. See the validation panel.');
    return;
  }

  const token: CancellationToken = { cancelled: false };
  session.token = token;
  viewport.tickEnabled = false;
  appStore.set({ baking: true, progress: null, result: null });

  try {
    const result = await bakeVAT(
      {
        character: session.character,
        sampler: session.sampler,
        evaluator: session.evaluator,
        animations: state.animations,
        settings: state.settings,
      },
      (progress) => appStore.set({ progress }),
      token,
    );

    const post = validatePostBake(result);
    const build = buildVATStaticGeometry(session.character, result);
    session.staticBuild = build;
    for (const w of build.warnings) log('warning', w);

    appStore.set({
      result,
      reports: [pre, post],
      totalFrames: result.totalFrames,
      previewMode: 'both',
    });

    viewport.setVATPreview({ result, geometry: build.geometry });
    viewport.setMode('both');

    log(
      'info',
      `Baked ${result.totalFrames} frames x ${result.vertexCount.toLocaleString()} vertices ` +
        `into ${result.layout.width} x ${result.layout.height} in ${(result.durationMs / 1000).toFixed(2)} s.`,
    );
    if (!post.ok) log('error', 'Post-bake validation reported errors.');
  } catch (err) {
    if (err instanceof BakeCancelled) log('warning', 'Bake cancelled.');
    else log('error', `Bake failed: ${(err as Error).message}`);
  } finally {
    session.token = null;
    viewport.tickEnabled = true;
    appStore.set({ baking: false });
  }
}

export function cancelBake(): void {
  if (session.token) session.token.cancelled = true;
}

// ---- export ----------------------------------------------------------------

function names() {
  return outputNames(appStore.get().settings.assetName);
}

function transformFor(result: BakeResult) {
  return result.settings.axisConversion === 'gltf_to_unreal' ? gltfToUnreal : null;
}

export function exportPositionEXR(): void {
  const result = appStore.get().result;
  if (!result) return;
  const buffer = writeEXR(result.positions, result.layout.width, result.layout.height, {
    pixelType: result.settings.precision === 'RGBA16F' ? 'half' : 'float',
    transform: transformFor(result),
  });
  downloadBlob(buffer, result.bone ? names().bonePosition : names().position, 'image/x-exr');
}

export function exportBoneRotationEXR(): void {
  const result = appStore.get().result;
  if (!result?.bone) return;
  // Quaternion components are not coordinates in the sense the axis swizzle
  // handles, so the conversion is applied to the ROTATION rather than to the
  // channel order. Bake with axisConversion = none and swizzle in the material,
  // or handle the basis change engine-side; converting a quaternion by
  // reordering its channels would silently produce a mirrored rotation.
  const buffer = writeEXR(
    result.bone.rotations,
    result.layout.width,
    result.layout.height,
    {
      pixelType: result.settings.precision === 'RGBA16F' ? 'half' : 'float',
      transform: null,
    },
  );
  downloadBlob(buffer, names().boneRotation, 'image/x-exr');
}

export function exportNormalEXR(): void {
  const result = appStore.get().result;
  if (!result?.normals) return;
  const buffer = writeEXR(result.normals, result.layout.width, result.layout.height, {
    pixelType: result.settings.precision === 'RGBA16F' ? 'half' : 'float',
    transform: transformFor(result),
  });
  downloadBlob(buffer, names().normal, 'image/x-exr');
}

export function exportLookupEXR(): void {
  const result = appStore.get().result;
  if (!result?.lookupTexture) return;
  const { data, width, height } = result.lookupTexture;
  // Frame indices and FPS are counts, never coordinates, so no axis conversion.
  const buffer = writeEXR(data, width, height, { pixelType: 'float', transform: null });
  downloadBlob(buffer, names().lookup, 'image/x-exr');
}

export function exportJSON(): void {
  const result = appStore.get().result;
  if (!result) return;
  downloadBlob(metadataToJSON(buildMetadata(result)), names().json, 'application/json');
}

export function exportCSV(): void {
  const result = appStore.get().result;
  if (!result) return;
  downloadBlob(metadataToCSV(buildMetadata(result)), names().csv, 'text/csv');
}

export function exportReport(): void {
  const reports = appStore.get().reports;
  if (reports.length === 0) return;
  downloadBlob(reportToText(reports), names().report, 'text/plain');
}

export async function exportMesh(): Promise<void> {
  const build = session.staticBuild;
  if (!build) {
    log('error', 'Bake first: the static mesh is generated from the baked rest pose.');
    return;
  }
  appStore.set({ busy: 'Writing GLB…' });
  try {
    const mesh = buildVATMesh(build);
    const buffer = await exportGLB(mesh, appStore.get().settings.assetName);
    downloadBlob(buffer, names().mesh, 'model/gltf-binary');
    log('info', `Exported ${names().mesh}.`);
  } catch (err) {
    log('error', `GLB export failed: ${(err as Error).message}`);
  } finally {
    appStore.set({ busy: null });
  }
}

export async function exportAll(): Promise<void> {
  const state = appStore.get();
  if (!state.result) return;
  exportPositionEXR();
  if (state.result.bone) exportBoneRotationEXR();
  if (state.result.normals) exportNormalEXR();
  if (state.result.lookupTexture) exportLookupEXR();
  exportJSON();
  exportCSV();
  exportReport();
  await exportMesh();
}

export function frameAtGlobal(globalFrame: number) {
  return resolveGlobalFrame(appStore.get().animations, globalFrame);
}

export function getOutputNames() {
  return names();
}

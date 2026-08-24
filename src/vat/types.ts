import * as THREE from 'three';

export type PositionMode = 'absolute' | 'offset';
export type Precision = 'RGBA16F' | 'RGBA32F';
export type WidthSetting = 'auto' | 1024 | 2048 | 4096 | 8192 | 16384;
export type AxisConversion = 'none' | 'gltf_to_unreal';
/**
 * 'vertex' stores one position per vertex per frame — simple, exact, but the
 * texture scales with mesh density. 'bone' stores one transform per bone per
 * frame and re-skins in the material — typically 100x+ smaller, at the cost of
 * per-vertex material work and no support for non-uniform bone scale.
 */
export type VATMode = 'vertex' | 'bone';
export type Compatibility = 'ok' | 'warning' | 'error';

/** A clip in the bake set. `id` ALWAYS equals the row index in the library. */
export interface VATAnimation {
  /** stable internal key (never exported, used by React lists) */
  uid: string;
  /** sequential, regenerated on every reorder */
  id: number;
  name: string;
  sourceFilename: string;
  /** clip whose track names have been remapped onto the base skeleton */
  clip: THREE.AnimationClip;
  /** clip as it arrived, kept so retargeting can be redone when options change */
  rawClip: THREE.AnimationClip;
  duration: number;
  /** detected from key spacing in the source file, null when indeterminate */
  sourceFPS: number | null;
  /** bake FPS this clip was ranged with */
  fps: number;
  loop: boolean;
  startFrame: number;
  /** inclusive */
  endFrame: number;
  frameCount: number;
  compatibility: Compatibility;
  compatibilityNote: string;
  missingBones: string[];
  extraBones: string[];
  matchedBones: number;
  /** hips-height ratio measured against this clip's own source file */
  autoTranslationScale: number;
}

export interface BakeSettings {
  assetName: string;
  vatMode: VATMode;
  bakeFPS: number;
  positionMode: PositionMode;
  precision: Precision;
  textureWidth: WidthSetting;
  bakeNormals: boolean;
  generateLookupTexture: boolean;
  /** uniform scale applied when moving from FBX root space into VAT object space */
  unitScale: number;
  /** vertexIndex = uv1.x + uv1.y * lookupSplit */
  lookupSplit: number;
  maxTextureDimension: number;
  axisConversion: AxisConversion;
}

export interface MatchOptions {
  stripNamespaces: boolean;
  extraNamespaces: string;
  stripNonRootTranslation: boolean;
  stripScaleTracks: boolean;
  translationScaleMode: 'none' | 'auto' | 'manual';
  translationScale: number;
}

export interface NamingOptions {
  assetPrefixes: string;
  animationPrefixes: string;
  animationTokens: string;
}

export interface TextureLayout {
  width: number;
  height: number;
  /** vertexCount * totalFrames */
  usedSamples: number;
  /** width * height */
  capacity: number;
  wastedSamples: number;
  bytes: number;
}

/** Bone-mode payload. Null on a vertex-mode bake. */
export interface BoneBakeData {
  layout: TextureLayout;
  /** RGBA, translation of B_k in XYZ */
  positions: Float32Array;
  /** RGBA, quaternion of B_k in XYZW */
  rotations: Float32Array;
  boneCount: number;
  boneNames: string[];
  /** vertexCount*4, boneIndex + weight*WEIGHT_SCALE */
  packedInfluences: Float32Array;
  /** translation range across the whole bake */
  bounds: Bounds;
  /** largest |scale - 1| on any bone on any frame; non-zero means lost squash/stretch */
  maxScaleDeviation: number;
  /**
   * Largest per-vertex disagreement, in object-space units, between the bone path
   * and the ground-truth vertex path, measured on sampled frames.
   */
  maxReconstructionError: number;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface BakeProgressInfo {
  animationIndex: number;
  animationCount: number;
  animationName: string;
  frame: number;
  frameCount: number;
  globalFrame: number;
  totalFrames: number;
  percent: number;
  phase: 'rest' | 'sampling' | 'packing' | 'done';
}

export interface AnimationRange {
  index: number;
  name: string;
  startFrame: number;
  endFrame: number;
  frameCount: number;
  fps: number;
  duration: number;
  loop: boolean;
  sourceFilename: string;
}

export interface BakeResult {
  layout: TextureLayout;
  /** RGBA, width*height*4, source (unconverted) space */
  positions: Float32Array;
  normals: Float32Array | null;
  /** vertexCount*3, VAT object space */
  restPositions: Float32Array;
  restNormals: Float32Array;
  vertexCount: number;
  totalFrames: number;
  /** absolute animated position bounds over every animation and frame */
  bounds: Bounds;
  /** range of the values actually written to the texture (equals bounds in absolute mode) */
  storedBounds: Bounds;
  ranges: AnimationRange[];
  settings: BakeSettings;
  nanCount: number;
  /** max |skinnedRest - rawGeometry| in object space; large values imply a bind-pose mismatch */
  restDeviation: number;
  durationMs: number;
  lookupTexture: { data: Float32Array; width: number; height: number } | null;
  /** populated only when settings.vatMode === 'bone' */
  bone: BoneBakeData | null;
}

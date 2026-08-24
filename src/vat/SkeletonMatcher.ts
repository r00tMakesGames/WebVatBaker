import * as THREE from 'three';
import type { Compatibility, MatchOptions } from './types';

/**
 * Skeleton normalization + track retargeting.
 *
 * Animation FBX files carry their own skeleton hierarchy and their own naming
 * conventions. Tracks are remapped onto the BASE character's bone names using a
 * normalized key so that all of these resolve to the same bone:
 *
 *   mixamorig:Hips   mixamorig_Hips   Armature|Hips   Hips   hips
 */

const KNOWN_NAMESPACES = ['mixamorig', 'mixamo', 'armature', 'root', 'rig', 'char', 'skel'];

/** Bones that are allowed to keep translation when non-root translation is stripped. */
const ROOT_LIKE = new Set(['hips', 'pelvis', 'root', 'reference', 'rootmotion']);

export function normalizeBoneName(raw: string, options: MatchOptions): string {
  let name = raw;

  // Path-style prefixes: `Armature|mixamorig:Hips`
  const bar = name.lastIndexOf('|');
  if (bar >= 0) name = name.slice(bar + 1);

  if (options.stripNamespaces) {
    const colon = name.lastIndexOf(':');
    if (colon >= 0) name = name.slice(colon + 1);
  }

  let key = name.toLowerCase();

  const namespaces = [
    ...KNOWN_NAMESPACES,
    ...options.extraNamespaces
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ];
  if (options.stripNamespaces) {
    for (const ns of namespaces) {
      if (key.startsWith(ns) && key.length > ns.length) {
        const rest = key.slice(ns.length).replace(/^[_:.\-\s]+/, '');
        if (rest.length > 0 && rest !== key) {
          key = rest;
          break;
        }
      }
    }
  }

  // Collapse separators so `left_arm`, `LeftArm` and `Left Arm` unify.
  return key.replace(/[^a-z0-9]/g, '');
}

export interface BoneIndex {
  /** normalized key -> real bone name on the base skeleton */
  byKey: Map<string, string>;
  /** real bone name -> bone */
  byName: Map<string, THREE.Bone>;
  rootLike: Set<string>;
}

export function buildBoneIndex(skeleton: THREE.Skeleton, options: MatchOptions): BoneIndex {
  const byKey = new Map<string, string>();
  const byName = new Map<string, THREE.Bone>();
  const rootLike = new Set<string>();

  for (const bone of skeleton.bones) {
    const key = normalizeBoneName(bone.name, options);
    if (!byKey.has(key)) byKey.set(key, bone.name);
    byName.set(bone.name, bone);

    const parentIsBone = !!bone.parent && (bone.parent as THREE.Bone).isBone === true;
    if (!parentIsBone || ROOT_LIKE.has(key)) rootLike.add(bone.name);
  }
  return { byKey, byName, rootLike };
}

export interface RetargetResult {
  clip: THREE.AnimationClip;
  matchedBones: number;
  /** base skeleton bones that receive no animation */
  missingBones: string[];
  /** source bones with no counterpart on the base skeleton */
  extraBones: string[];
  compatibility: Compatibility;
  compatibilityNote: string;
  droppedTracks: number;
}

function scaleTrackValues(track: THREE.KeyframeTrack, factor: number) {
  const v = track.values;
  for (let i = 0; i < v.length; i++) v[i] *= factor;
}

/**
 * Rebuild `clip` so every track targets a bone that exists on `skeleton`.
 * Track names become `<baseBoneName>.<property>`.
 */
export function retargetClip(
  clip: THREE.AnimationClip,
  index: BoneIndex,
  options: MatchOptions,
  autoTranslationScale = 1,
): RetargetResult {
  const tracks: THREE.KeyframeTrack[] = [];
  const animatedBones = new Set<string>();
  const extra = new Set<string>();
  let dropped = 0;

  const translationScale =
    options.translationScaleMode === 'none'
      ? 1
      : options.translationScaleMode === 'auto'
        ? autoTranslationScale
        : options.translationScale;

  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name);
    const property = parsed.propertyName;
    if (property !== 'position' && property !== 'quaternion' && property !== 'scale') {
      dropped++;
      continue;
    }
    if (property === 'scale' && options.stripScaleTracks) {
      dropped++;
      continue;
    }

    const sourceName = parsed.nodeName ?? track.name.split('.')[0];
    const key = normalizeBoneName(sourceName, options);
    const targetName = index.byKey.get(key);
    if (!targetName) {
      extra.add(sourceName);
      dropped++;
      continue;
    }

    const isRootLike = index.rootLike.has(targetName);
    if (property === 'position' && options.stripNonRootTranslation && !isRootLike) {
      dropped++;
      continue;
    }

    const copy = track.clone();
    copy.name = `${targetName}.${property}`;
    if (property === 'position' && translationScale !== 1) {
      scaleTrackValues(copy, translationScale);
    }
    tracks.push(copy);
    animatedBones.add(targetName);
  }

  const retargeted = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  retargeted.resetDuration();

  const missing: string[] = [];
  for (const name of index.byName.keys()) {
    if (!animatedBones.has(name)) missing.push(name);
  }

  const total = index.byName.size;
  const matched = animatedBones.size;
  let compatibility: Compatibility = 'ok';
  let note = 'All base bones animated.';

  if (matched === 0) {
    compatibility = 'error';
    note = 'No tracks could be matched to the base skeleton. Check bone naming.';
  } else if (tracks.length === 0) {
    compatibility = 'error';
    note = 'Every track was dropped.';
  } else if (missing.length > 0) {
    const ratio = matched / total;
    compatibility = ratio < 0.5 ? 'error' : 'warning';
    note =
      ratio < 0.5
        ? `Only ${matched} of ${total} base bones are animated — likely a different skeleton.`
        : `${missing.length} base bone(s) hold their rest pose.`;
  }

  return {
    clip: retargeted,
    matchedBones: matched,
    missingBones: missing,
    extraBones: [...extra],
    compatibility,
    compatibilityNote: note,
    droppedTracks: dropped,
  };
}

/**
 * Estimate a translation scale factor by comparing the height of the matched
 * hips/root bone in the source file against the base skeleton.
 */
export function estimateTranslationScale(
  baseSkeleton: THREE.Skeleton,
  animationRoot: THREE.Object3D | null,
  options: MatchOptions,
): number {
  if (!animationRoot) return 1;

  const target = baseSkeleton.bones.find((b) =>
    ROOT_LIKE.has(normalizeBoneName(b.name, options)),
  );
  if (!target) return 1;
  const key = normalizeBoneName(target.name, options);

  const matches: THREE.Object3D[] = [];
  animationRoot.updateMatrixWorld(true);
  animationRoot.traverse((o) => {
    if (normalizeBoneName(o.name, options) === key) matches.push(o);
  });
  const source = matches[0];
  if (!source) return 1;

  const a = new THREE.Vector3().setFromMatrixPosition(target.matrixWorld).length();
  const b = new THREE.Vector3().setFromMatrixPosition(source.matrixWorld).length();
  if (a < 1e-6 || b < 1e-6) return 1;
  const ratio = a / b;
  return ratio > 0.001 && ratio < 1000 ? ratio : 1;
}

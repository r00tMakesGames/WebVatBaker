import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

export interface BoneRest {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface BaseCharacter {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh;
  skeleton: THREE.Skeleton;
  vertexCount: number;
  /** local-TRS snapshot of every bone as authored, used as the rest pose */
  boneRest: BoneRest[];
  materials: THREE.Material[];
  uvSets: string[];
  bounds: THREE.Box3;
  sourceFilename: string;
  ignoredMeshes: string[];
}

export interface ImportIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface BaseImportResult {
  character: BaseCharacter | null;
  issues: ImportIssue[];
}

export interface AnimationImportResult {
  clips: THREE.AnimationClip[];
  root: THREE.Group | null;
  issues: ImportIssue[];
}

// FBX files reference external texture paths that will 404 in the browser and
// bury the console. Every fetch is redirected to an inline white pixel; the
// baker never needs the actual maps, and MeshExporter strips them again.
const WHITE_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

function makeLoader(): FBXLoader {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (url.startsWith('data:') ? url : WHITE_PIXEL));
  return new FBXLoader(manager);
}

export function parseFBX(buffer: ArrayBuffer): THREE.Group {
  return makeLoader().parse(buffer, '') as unknown as THREE.Group;
}

function collectSkinnedMeshes(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
}

function toArray(m: THREE.Material | THREE.Material[]): THREE.Material[] {
  return Array.isArray(m) ? m : [m];
}

export function importBaseCharacter(
  buffer: ArrayBuffer,
  filename: string,
): BaseImportResult {
  const issues: ImportIssue[] = [];
  let root: THREE.Group;
  try {
    root = parseFBX(buffer);
  } catch (err) {
    return {
      character: null,
      issues: [{ level: 'error', message: `FBX parse failed: ${(err as Error).message}` }],
    };
  }

  // VAT object space is the FBX root's space, so pin the root at the origin.
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  const skinned = collectSkinnedMeshes(root);
  if (skinned.length === 0) {
    issues.push({
      level: 'error',
      message: 'No SkinnedMesh found. The base file needs a skinned mesh, not a static mesh.',
    });
    return { character: null, issues };
  }

  // Primary mesh = the densest one. Others are reported, not baked.
  skinned.sort(
    (a, b) =>
      (b.geometry.getAttribute('position')?.count ?? 0) -
      (a.geometry.getAttribute('position')?.count ?? 0),
  );
  const mesh = skinned[0];
  const ignoredMeshes = skinned.slice(1).map((m) => m.name || '(unnamed)');
  if (ignoredMeshes.length > 0) {
    issues.push({
      level: 'warning',
      message: `${ignoredMeshes.length} additional skinned mesh(es) found and skipped: ${ignoredMeshes.join(', ')}. Only the densest mesh is baked.`,
    });
  }

  const geometry = mesh.geometry as THREE.BufferGeometry;
  const position = geometry.getAttribute('position');
  const skinIndex = geometry.getAttribute('skinIndex');
  const skinWeight = geometry.getAttribute('skinWeight');
  const normal = geometry.getAttribute('normal');

  if (!position || position.count === 0) {
    issues.push({ level: 'error', message: 'Mesh has no vertices.' });
  }
  if (!skinIndex) issues.push({ level: 'error', message: 'Mesh has no skinIndex attribute.' });
  if (!skinWeight) issues.push({ level: 'error', message: 'Mesh has no skinWeight attribute.' });
  if (!mesh.skeleton || mesh.skeleton.bones.length === 0) {
    issues.push({ level: 'error', message: 'Mesh has no skeleton.' });
  }
  if (!normal) {
    issues.push({
      level: 'warning',
      message: 'Mesh has no normals. Normals will be computed from the rest pose.',
    });
    geometry.computeVertexNormals();
  }
  if (issues.some((i) => i.level === 'error')) return { character: null, issues };

  const skeleton = mesh.skeleton;
  const boneRest: BoneRest[] = skeleton.bones.map((b) => ({
    position: b.position.clone(),
    quaternion: b.quaternion.clone(),
    scale: b.scale.clone(),
  }));

  const uvSets = Object.keys(geometry.attributes).filter((k) => k.startsWith('uv'));
  if (!geometry.getAttribute('uv')) {
    issues.push({
      level: 'warning',
      message: 'Mesh has no UV0. A zeroed UV0 will be written to the exported mesh.',
    });
  }

  const bounds = new THREE.Box3().setFromObject(mesh);

  return {
    character: {
      root,
      mesh,
      skeleton,
      vertexCount: position.count,
      boneRest,
      materials: toArray(mesh.material),
      uvSets,
      bounds,
      sourceFilename: filename,
      ignoredMeshes,
    },
    issues,
  };
}

export function importAnimationFBX(
  buffer: ArrayBuffer,
  filename: string,
): AnimationImportResult {
  const issues: ImportIssue[] = [];
  let root: THREE.Group;
  try {
    root = parseFBX(buffer);
  } catch (err) {
    return {
      clips: [],
      root: null,
      issues: [{ level: 'error', message: `FBX parse failed: ${(err as Error).message}` }],
    };
  }

  const clips = (root.animations ?? []).filter((c) => c.tracks.length > 0);
  if (clips.length === 0) {
    issues.push({
      level: 'error',
      message: `${filename} contains no animation tracks.`,
    });
  }
  return { clips, root, issues };
}

const COMMON_FPS = [12, 15, 24, 25, 30, 48, 50, 60, 90, 120];

/** Infer authoring FPS from the tightest key spacing across the clip. */
export function detectSourceFPS(clip: THREE.AnimationClip): number | null {
  let smallest = Infinity;
  for (const track of clip.tracks) {
    const t = track.times;
    for (let i = 1; i < t.length; i++) {
      const d = t[i] - t[i - 1];
      if (d > 1e-6 && d < smallest) smallest = d;
    }
  }
  if (!Number.isFinite(smallest)) return null;
  const raw = 1 / smallest;
  for (const f of COMMON_FPS) {
    if (Math.abs(raw - f) / f < 0.02) return f;
  }
  return Math.round(raw * 100) / 100;
}

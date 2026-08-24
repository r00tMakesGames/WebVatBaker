import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { BaseCharacter } from './FBXImporter';
import type { BakeResult } from './types';

/**
 * VAT lookup UV.
 *
 * Importers are free to reorder, split or re-weld vertices, so the VAT sample
 * index cannot be the mesh's vertex order. It is carried per-vertex in a second
 * UV set instead:
 *
 *   uv1 = ( vertexIndex % split , floor(vertexIndex / split) )
 *   vertexIndex = round(uv1.x) + round(uv1.y) * split
 *
 * split defaults to 1024 because half-precision floats represent integers
 * exactly only up to 2048, and Unreal stores UVs as half unless "Use Full
 * Precision UVs" is enabled. With split = 1024 both components stay under 2048
 * for meshes up to ~1M vertices.
 *
 * The values are also unique per vertex, which prevents any importer from
 * welding two VAT vertices into one.
 */
export function buildLookupUVs(vertexCount: number, split: number): Float32Array {
  const uv = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i++) {
    uv[i * 2] = i % split;
    uv[i * 2 + 1] = Math.floor(i / split);
  }
  return uv;
}

export interface StaticMeshBuild {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
  warnings: string[];
}

/**
 * Rest-pose static mesh: no skeleton, no skin attributes, VAT lookup added.
 * Positions and normals come from the baker so the mesh and the texture are
 * guaranteed to share one coordinate space.
 */
export function buildVATStaticGeometry(
  character: BaseCharacter,
  result: BakeResult,
): StaticMeshBuild {
  const src = character.mesh.geometry;
  const warnings: string[] = [];
  const geometry = new THREE.BufferGeometry();
  const vertexCount = result.vertexCount;

  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(result.restPositions.slice(), 3),
  );
  geometry.setAttribute('normal', new THREE.BufferAttribute(result.restNormals.slice(), 3));

  // UV0 is preserved untouched.
  const uv0 = src.getAttribute('uv');
  if (uv0) {
    const copy = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      copy[i * 2] = uv0.getX(i);
      copy[i * 2 + 1] = uv0.getY(i);
    }
    geometry.setAttribute('uv', new THREE.BufferAttribute(copy, 2));
  } else {
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2));
    warnings.push('Source mesh had no UV0; a zeroed UV0 was written.');
  }

  // Vertex mode addresses the texture per vertex, so uv1 carries the sample
  // index. Bone mode never looks up per vertex; it carries the four skin
  // influences instead, packed two per UV set:
  //
  //   uv1 = ( idx0 + w0*0.99 , idx1 + w1*0.99 )
  //   uv2 = ( idx2 + w2*0.99 , idx3 + w3*0.99 )
  //
  // Two channels rather than four because GLTFExporter only maps uv..uv3, and
  // the mesh still needs UV0 for its real texture coordinates.
  const bone = result.bone;
  let slot = 2;
  if (bone) {
    const packed = bone.packedInfluences;
    const a = new Float32Array(vertexCount * 2);
    const b = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      a[i * 2] = packed[i * 4];
      a[i * 2 + 1] = packed[i * 4 + 1];
      b[i * 2] = packed[i * 4 + 2];
      b[i * 2 + 1] = packed[i * 4 + 3];
    }
    geometry.setAttribute('uv1', new THREE.BufferAttribute(a, 2));
    geometry.setAttribute('uv2', new THREE.BufferAttribute(b, 2));
    slot = 3;
    warnings.push(
      'Bone mode: uv1/uv2 carry packed skin influences. "Use Full Precision UVs" is REQUIRED on import — half-precision UVs will corrupt the packed weights.',
    );
  } else {
    geometry.setAttribute(
      'uv1',
      new THREE.BufferAttribute(buildLookupUVs(vertexCount, result.settings.lookupSplit), 2),
    );
  }

  // Any additional source UV sets shift up into whatever slots are left.
  const extraSets = Object.keys(src.attributes).filter((k) => /^uv[1-3]$/.test(k));
  for (const key of extraSets) {
    if (slot > 3) {
      warnings.push(
        `UV set "${key}" dropped: glTF supports at most 4 UV channels and the VAT data claimed the rest.`,
      );
      continue;
    }
    const attr = src.getAttribute(key);
    const copy = new Float32Array(vertexCount * 2);
    for (let i = 0; i < vertexCount; i++) {
      copy[i * 2] = attr.getX(i);
      copy[i * 2 + 1] = attr.getY(i);
    }
    geometry.setAttribute(`uv${slot}`, new THREE.BufferAttribute(copy, 2));
    warnings.push(`Source "${key}" was moved to "uv${slot}" to make room for the VAT lookup.`);
    slot++;
  }

  const color = src.getAttribute('color');
  if (color) geometry.setAttribute('color', color.clone());

  if (src.index) geometry.setIndex(src.index.clone());
  for (const group of src.groups) {
    geometry.addGroup(group.start, group.count, group.materialIndex);
  }

  // Tangents need an indexed geometry; FBX meshes usually arrive non-indexed.
  const existingTangent = src.getAttribute('tangent');
  if (existingTangent && existingTangent.count === vertexCount) {
    geometry.setAttribute('tangent', existingTangent.clone());
  } else if (geometry.index && geometry.getAttribute('uv')) {
    try {
      geometry.computeTangents();
    } catch (err) {
      warnings.push(`Tangents could not be computed (${(err as Error).message}).`);
    }
  } else {
    warnings.push(
      'No tangents exported (source geometry is not indexed). Unreal will generate MikkTSpace tangents on import.',
    );
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // Keep names, colours and material slots; drop the placeholder texture maps
  // that FBX texture references resolved to.
  const materials = character.materials.map((m) => {
    const clone = m.clone();
    const any = clone as unknown as Record<string, unknown>;
    for (const key of [
      'map',
      'normalMap',
      'roughnessMap',
      'metalnessMap',
      'specularMap',
      'emissiveMap',
      'aoMap',
      'bumpMap',
      'alphaMap',
      'displacementMap',
    ]) {
      if (any[key]) any[key] = null;
    }
    clone.name = m.name || clone.name;
    return clone;
  });

  return { geometry, materials, warnings };
}

export function buildVATMesh(build: StaticMeshBuild): THREE.Mesh {
  const material = build.materials.length === 1 ? build.materials[0] : build.materials;
  const mesh = new THREE.Mesh(build.geometry, material);
  mesh.name = 'VAT_StaticMesh';
  return mesh;
}

export function exportGLB(mesh: THREE.Object3D, assetName: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      mesh,
      (out) => {
        if (out instanceof ArrayBuffer) resolve(out);
        else reject(new Error('GLTFExporter returned JSON instead of a binary buffer.'));
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      {
        binary: true,
        onlyVisible: false,
        includeCustomExtensions: false,
        // No animation is exported: motion lives entirely in the VAT textures.
        animations: [],
        trs: false,
        maxTextureSize: 1,
      },
    );
  });
}

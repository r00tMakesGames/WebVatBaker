import * as THREE from 'three';

/**
 * Explicit CPU skinning, allocation-free in the vertex loop.
 *
 * For every bone the full transform into VAT object space is folded once per
 * frame into a flat Float32Array:
 *
 *   M_i = S * meshWorld * bindMatrixInverse * (boneWorld_i * boneInverse_i) * bindMatrix
 *
 * This is exactly what SkinnedMesh.applyBoneTransform() computes, plus the mesh
 * world matrix and the unit-scale matrix S, with the per-vertex constants hoisted
 * out of the loop. Because skinning is linear in the bone matrices, the weighted
 * sum can be taken over M_i directly:
 *
 *   p' = ( sum_k w_k * M_{b_k} ) * p
 *
 * Only the 12 elements of the 4x3 affine part are accumulated. Normals use the
 * upper 3x3 of the same blended matrix and are renormalized, matching GPU
 * skinning behaviour.
 */

export interface EvalTarget {
  /** destination for XYZ */
  positions: Float32Array;
  positionBase: number;
  positionStride: number;
  /** destination for normals, or null */
  normals: Float32Array | null;
  normalBase: number;
  normalStride: number;
  /** [minX,minY,minZ,maxX,maxY,maxZ] accumulator, or null */
  bounds: Float32Array | null;
}

export function makeEvalTarget(): EvalTarget {
  return {
    positions: new Float32Array(0),
    positionBase: 0,
    positionStride: 3,
    normals: null,
    normalBase: 0,
    normalStride: 3,
    bounds: null,
  };
}

export class SkinEvaluator {
  readonly vertexCount: number;

  private readonly basePositions: Float32Array;
  private readonly baseNormals: Float32Array;
  private readonly skinIndex: Uint32Array;
  private readonly skinWeight: Float32Array;
  private readonly boneCount: number;
  private readonly boneMatrices: Float32Array;
  private readonly fallback = new Float32Array(16);

  private readonly space = new THREE.Matrix4();
  private readonly pre = new THREE.Matrix4();
  private readonly tmpA = new THREE.Matrix4();
  private readonly tmpB = new THREE.Matrix4();

  constructor(
    private readonly mesh: THREE.SkinnedMesh,
    unitScale = 1,
  ) {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const skinIndex = geometry.getAttribute('skinIndex');
    const skinWeight = geometry.getAttribute('skinWeight');

    this.vertexCount = position.count;
    this.boneCount = mesh.skeleton.bones.length;
    this.boneMatrices = new Float32Array(this.boneCount * 16);

    // Copy attributes into plain typed arrays so normalized/interleaved
    // attributes cannot slow down or corrupt the hot loop.
    this.basePositions = new Float32Array(this.vertexCount * 3);
    this.baseNormals = new Float32Array(this.vertexCount * 3);
    this.skinIndex = new Uint32Array(this.vertexCount * 4);
    this.skinWeight = new Float32Array(this.vertexCount * 4);

    for (let i = 0; i < this.vertexCount; i++) {
      this.basePositions[i * 3 + 0] = position.getX(i);
      this.basePositions[i * 3 + 1] = position.getY(i);
      this.basePositions[i * 3 + 2] = position.getZ(i);
      if (normal) {
        this.baseNormals[i * 3 + 0] = normal.getX(i);
        this.baseNormals[i * 3 + 1] = normal.getY(i);
        this.baseNormals[i * 3 + 2] = normal.getZ(i);
      }
      for (let k = 0; k < 4; k++) {
        const idx = skinIndex.getComponent(i, k);
        this.skinIndex[i * 4 + k] = idx >= 0 && idx < this.boneCount ? idx : 0;
        this.skinWeight[i * 4 + k] = skinWeight.getComponent(i, k);
      }
    }

    this.setUnitScale(unitScale);
  }

  setUnitScale(scale: number): void {
    this.space.makeScale(scale, scale, scale);
  }

  /** Folded per-bone matrices, boneCount * 16. Valid after updateBoneMatrices(). */
  get boneMatrixArray(): Float32Array {
    return this.boneMatrices;
  }

  /** The zero-weight fallback, unitScale * meshWorld. Also every bone's rest matrix. */
  get fallbackMatrix(): Float32Array {
    return this.fallback;
  }

  get skinIndexArray(): Uint32Array {
    return this.skinIndex;
  }

  get skinWeightArray(): Float32Array {
    return this.skinWeight;
  }

  get boneInfluenceCount(): number {
    return this.boneCount;
  }

  /**
   * Largest distance between a skinned result and the raw bind-pose geometry
   * carried into the same space by the mesh transform alone. A large value means
   * the file was authored in a pose other than its bind pose.
   *
   * Requires updateBoneMatrices() to have run, since it reuses the zero-weight
   * fallback matrix (unitScale * meshWorld).
   */
  restDeviation(skinned: Float32Array): number {
    const fb = this.fallback;
    const bp = this.basePositions;
    let worst = 0;
    for (let v = 0; v < this.vertexCount; v++) {
      const i = v * 3;
      const x = bp[i], y = bp[i + 1], z = bp[i + 2];
      const dx = skinned[i] - (fb[0] * x + fb[4] * y + fb[8] * z + fb[12]);
      const dy = skinned[i + 1] - (fb[1] * x + fb[5] * y + fb[9] * z + fb[13]);
      const dz = skinned[i + 2] - (fb[2] * x + fb[6] * y + fb[10] * z + fb[14]);
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > worst) worst = d;
    }
    return worst;
  }

  /** Recompute bone matrices from the CURRENT world matrices. Call once per frame. */
  updateBoneMatrices(): void {
    const mesh = this.mesh;
    const skeleton = mesh.skeleton;

    this.pre
      .multiplyMatrices(this.space, mesh.matrixWorld)
      .multiply(mesh.bindMatrixInverse);

    // A vertex with zero total weight is simply carried by the mesh transform.
    this.tmpA.multiplyMatrices(this.pre, mesh.bindMatrix);
    this.tmpA.toArray(this.fallback, 0);

    for (let i = 0; i < this.boneCount; i++) {
      this.tmpB.multiplyMatrices(skeleton.bones[i].matrixWorld, skeleton.boneInverses[i]);
      this.tmpA.multiplyMatrices(this.pre, this.tmpB).multiply(mesh.bindMatrix);
      this.tmpA.toArray(this.boneMatrices, i * 16);
    }
  }

  /**
   * Skin every vertex into `target`. Returns the number of non-finite components
   * encountered.
   */
  evaluate(target: EvalTarget): number {
    const bm = this.boneMatrices;
    const fb = this.fallback;
    const bp = this.basePositions;
    const bn = this.baseNormals;
    const si = this.skinIndex;
    const sw = this.skinWeight;
    const vc = this.vertexCount;

    const out = target.positions;
    const outBase = target.positionBase;
    const outStride = target.positionStride;
    const nrmOut = target.normals;
    const nrmBase = target.normalBase;
    const nrmStride = target.normalStride;
    const bounds = target.bounds;

    let minX = bounds ? bounds[0] : 0;
    let minY = bounds ? bounds[1] : 0;
    let minZ = bounds ? bounds[2] : 0;
    let maxX = bounds ? bounds[3] : 0;
    let maxY = bounds ? bounds[4] : 0;
    let maxZ = bounds ? bounds[5] : 0;
    let bad = 0;

    for (let v = 0; v < vc; v++) {
      const w4 = v * 4;
      let m0 = 0, m1 = 0, m2 = 0;
      let m4 = 0, m5 = 0, m6 = 0;
      let m8 = 0, m9 = 0, m10 = 0;
      let m12 = 0, m13 = 0, m14 = 0;
      let wsum = 0;

      for (let k = 0; k < 4; k++) {
        const w = sw[w4 + k];
        if (w === 0) continue;
        wsum += w;
        const b = si[w4 + k] * 16;
        m0 += bm[b] * w;      m1 += bm[b + 1] * w;   m2 += bm[b + 2] * w;
        m4 += bm[b + 4] * w;  m5 += bm[b + 5] * w;   m6 += bm[b + 6] * w;
        m8 += bm[b + 8] * w;  m9 += bm[b + 9] * w;   m10 += bm[b + 10] * w;
        m12 += bm[b + 12] * w; m13 += bm[b + 13] * w; m14 += bm[b + 14] * w;
      }

      if (wsum === 0) {
        m0 = fb[0];  m1 = fb[1];  m2 = fb[2];
        m4 = fb[4];  m5 = fb[5];  m6 = fb[6];
        m8 = fb[8];  m9 = fb[9];  m10 = fb[10];
        m12 = fb[12]; m13 = fb[13]; m14 = fb[14];
      } else if (wsum < 0.9999 || wsum > 1.0001) {
        const inv = 1 / wsum;
        m0 *= inv;  m1 *= inv;  m2 *= inv;
        m4 *= inv;  m5 *= inv;  m6 *= inv;
        m8 *= inv;  m9 *= inv;  m10 *= inv;
        m12 *= inv; m13 *= inv; m14 *= inv;
      }

      const p3 = v * 3;
      const x = bp[p3], y = bp[p3 + 1], z = bp[p3 + 2];
      const px = m0 * x + m4 * y + m8 * z + m12;
      const py = m1 * x + m5 * y + m9 * z + m13;
      const pz = m2 * x + m6 * y + m10 * z + m14;

      if (px !== px || py !== py || pz !== pz) bad++;

      const o = outBase + v * outStride;
      out[o] = px;
      out[o + 1] = py;
      out[o + 2] = pz;

      if (bounds) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (pz < minZ) minZ = pz;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
        if (pz > maxZ) maxZ = pz;
      }

      if (nrmOut) {
        const nx0 = bn[p3], ny0 = bn[p3 + 1], nz0 = bn[p3 + 2];
        let nx = m0 * nx0 + m4 * ny0 + m8 * nz0;
        let ny = m1 * nx0 + m5 * ny0 + m9 * nz0;
        let nz = m2 * nx0 + m6 * ny0 + m10 * nz0;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (len > 1e-8) {
          const il = 1 / len;
          nx *= il; ny *= il; nz *= il;
        } else {
          nx = 0; ny = 1; nz = 0;
        }
        const no = nrmBase + v * nrmStride;
        nrmOut[no] = nx;
        nrmOut[no + 1] = ny;
        nrmOut[no + 2] = nz;
      }
    }

    if (bounds) {
      bounds[0] = minX; bounds[1] = minY; bounds[2] = minZ;
      bounds[3] = maxX; bounds[4] = maxY; bounds[5] = maxZ;
    }
    return bad;
  }
}

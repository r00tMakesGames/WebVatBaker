import * as THREE from 'three';

/**
 * GLSL 3.00 ES VAT decoder.
 *
 * Integer math is deliberate. A linear sample index reaches
 * vertexCount * totalFrames, which passes 2^24 (the exact-integer ceiling for
 * fp32) at around 20k vertices x 840 frames. `uint` is exact to 4.29e9, and
 * texelFetch takes integer texel coordinates directly, so no half-texel
 * rounding can drift onto a neighbouring sample.
 */
export const VAT_VERTEX_SHADER = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
uniform mat3 normalMatrix;

uniform sampler2D vatPosition;
uniform sampler2D vatNormal;

uniform int   vatTexWidth;
uniform int   vatVertexCount;
uniform int   vatLookupSplit;
uniform int   vatFrameLo;
uniform int   vatFrameHi;
uniform float vatFrameBlend;
uniform int   vatPositionMode;   // 0 = absolute, 1 = offset from rest
uniform int   vatUseNormals;

// --- bone mode ---
uniform sampler2D vatBoneRotation;
uniform int   vatMode;           // 0 = vertex, 1 = bone
uniform int   vatBoneCount;
uniform float vatWeightScale;

in vec3 position;   // rest pose
in vec3 normal;     // rest pose
in vec2 uv1;        // vertex mode: VAT lookup | bone mode: influences 0,1
in vec2 uv2;        // bone mode: influences 2,3

out vec3 vNormal;

int vatVertexIndex() {
  return int(uv1.x + 0.5) + int(uv1.y + 0.5) * vatLookupSplit;
}

vec3 vatFetch(sampler2D tex, int frame, int vertexIndex) {
  int linear = frame * vatVertexCount + vertexIndex;
  ivec2 texel = ivec2(linear % vatTexWidth, linear / vatTexWidth);
  return texelFetch(tex, texel, 0).xyz;
}

// ---------------------------------------------------------------------------
// Bone mode
// ---------------------------------------------------------------------------

vec4 vatFetch4(sampler2D tex, int frame, int index, int stride) {
  int linear = frame * stride + index;
  ivec2 texel = ivec2(linear % vatTexWidth, linear / vatTexWidth);
  return texelFetch(tex, texel, 0);
}

vec3 quatRotate(vec4 q, vec3 v) {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

/** Blend the two frames for one bone, then apply it to the rest position. */
void vatBoneSample(int bone, out vec4 rot, out vec3 pos) {
  vec4 rA = vatFetch4(vatBoneRotation, vatFrameLo, bone, vatBoneCount);
  vec4 rB = vatFetch4(vatBoneRotation, vatFrameHi, bone, vatBoneCount);
  // nlerp with a hemisphere check. The bake already enforces continuity between
  // consecutive frames, but the check costs nothing and makes the shader correct
  // on its own terms rather than dependent on that guarantee.
  if (dot(rA, rB) < 0.0) rB = -rB;
  rot = normalize(mix(rA, rB, vatFrameBlend));

  vec3 pA = vatFetch4(vatPosition, vatFrameLo, bone, vatBoneCount).xyz;
  vec3 pB = vatFetch4(vatPosition, vatFrameHi, bone, vatBoneCount).xyz;
  pos = mix(pA, pB, vatFrameBlend);
}

void vatSkin(out vec3 outPos, out vec3 outNrm) {
  vec4 packed = vec4(uv1.x, uv1.y, uv2.x, uv2.y);
  vec3 accP = vec3(0.0);
  vec3 accN = vec3(0.0);
  float wsum = 0.0;

  for (int k = 0; k < 4; k++) {
    float v = packed[k];
    float boneF = floor(v);
    float w = (v - boneF) / vatWeightScale;
    if (w <= 0.0) continue;
    wsum += w;

    vec4 rot; vec3 pos;
    vatBoneSample(int(boneF), rot, pos);

    accP += w * (quatRotate(rot, position) + pos);
    accN += w * quatRotate(rot, normal);
  }

  if (wsum > 1e-6) {
    outPos = accP / wsum;
    outNrm = normalize(accN / wsum);
  } else {
    outPos = position;
    outNrm = normal;
  }
}

void main() {
  vec3 p;
  vec3 n;

  if (vatMode == 1) {
    vatSkin(p, n);
  } else {
    int vi = vatVertexIndex();

    vec3 a = vatFetch(vatPosition, vatFrameLo, vi);
    vec3 b = vatFetch(vatPosition, vatFrameHi, vi);
    vec3 sampled = mix(a, b, vatFrameBlend);

    p = (vatPositionMode == 1) ? position + sampled : sampled;

    n = normal;
    if (vatUseNormals == 1) {
      vec3 na = vatFetch(vatNormal, vatFrameLo, vi);
      vec3 nb = vatFetch(vatNormal, vatFrameHi, vi);
      n = normalize(mix(na, nb, vatFrameBlend));
    }
  }

  vNormal = normalize(normalMatrix * n);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

export const VAT_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform vec3 vatColor;
uniform float vatOpacity;

in vec3 vNormal;
out vec4 fragColor;

void main() {
  vec3 n = normalize(vNormal);
  vec3 keyDir = normalize(vec3(0.45, 0.85, 0.55));
  float key = max(dot(n, keyDir), 0.0);
  float fill = max(dot(n, normalize(vec3(-0.5, 0.2, -0.7))), 0.0) * 0.25;
  vec3 c = vatColor * (0.22 + 0.78 * key + fill);
  fragColor = vec4(c, vatOpacity);
}
`;

export interface VATMaterialConfig {
  positionTexture: THREE.Texture;
  normalTexture: THREE.Texture | null;
  texWidth: number;
  vertexCount: number;
  lookupSplit: number;
  positionMode: 'absolute' | 'offset';
  color: THREE.ColorRepresentation;
  wireframe: boolean;
  /** bone mode */
  mode?: 'vertex' | 'bone';
  rotationTexture?: THREE.Texture | null;
  boneCount?: number;
  weightScale?: number;
}

export function createVATMaterial(config: VATMaterialConfig): THREE.RawShaderMaterial {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VAT_VERTEX_SHADER,
    fragmentShader: VAT_FRAGMENT_SHADER,
    wireframe: config.wireframe,
    transparent: false,
    side: THREE.DoubleSide,
    uniforms: {
      vatPosition: { value: config.positionTexture },
      vatNormal: { value: config.normalTexture ?? config.positionTexture },
      vatTexWidth: { value: config.texWidth },
      vatVertexCount: { value: config.vertexCount },
      vatLookupSplit: { value: config.lookupSplit },
      vatFrameLo: { value: 0 },
      vatFrameHi: { value: 0 },
      vatFrameBlend: { value: 0 },
      vatPositionMode: { value: config.positionMode === 'offset' ? 1 : 0 },
      vatUseNormals: { value: config.normalTexture ? 1 : 0 },
      vatMode: { value: config.mode === 'bone' ? 1 : 0 },
      vatBoneRotation: { value: config.rotationTexture ?? config.positionTexture },
      vatBoneCount: { value: config.boneCount ?? 1 },
      vatWeightScale: { value: config.weightScale ?? 0.99 },
      vatColor: { value: new THREE.Color(config.color) },
      vatOpacity: { value: 1 },
    },
  });
  return material;
}

# Bone VAT mode

An alternative to the default vertex mode. Instead of storing a position per
**vertex** per frame, store a transform per **bone** per frame and re-do the
skinning in the material at runtime.

| | Vertex mode | Bone mode |
|---|---|---|
| Samples | `vertexCount × frames` | `boneCount × frames` |
| Typical count | 5,000 – 50,000 | 30 – 150 |
| Textures | position (+ optional normal) | position + rotation |
| Runtime cost | one fetch + lerp per vertex | 4 bones × (2 fetches + quat rotate) per vertex |
| Non-uniform bone scale | preserved | **lost** |
| Mesh data needed | 1 UV set (sample index) | 2 UV sets (packed influences) |
| Animated normals | separate texture | free — same quaternion rotates the normal |

A 20,000-vertex, 100-bone character with 600 frames of animation:
**96 MB** in vertex mode, **~940 KB** across both textures in bone mode.

---

## 1. Why it is exact

`SkinEvaluator` folds each bone's full transform into VAT object space as

```
M_k = S · meshWorld · bindMatrixInverse · (boneWorld_k · boneInverse_k) · bindMatrix
```

and skins a raw geometry vertex `p` with `P_anim = Σ w_k · M_k · p`.

The exported static mesh does not contain `p` — it contains the skinned rest
position `P_rest`. So shipping `M_k` directly would hand the shader the wrong
input. What gets stored instead is each bone's transform *relative to its own
rest transform*:

```
B_k = M_k · F⁻¹        where F = M_k evaluated at the rest pose
```

At the **bind pose** every bone satisfies `boneWorld_k · boneInverse_k = I`, so

```
M_rest_k = S · meshWorld · bindMatrixInverse · I · bindMatrix = F
```

— the same matrix for every bone. Therefore `M_rest_k · p = F · p = P_rest` for
every influencing bone, and the skinning identity survives the substitution
without approximation:

```
P_anim = Σ w_k · M_k · p
       = Σ w_k · B_k · (F · p)
       = Σ w_k · B_k · P_rest
```

which is exactly what the shader evaluates.

**The condition matters.** This is exact only when the rest pose *is* the bind
pose. That is precisely what `SkinEvaluator.restDeviation()` measures, so in
bone mode a non-zero deviation is not cosmetic — it is the error bound on every
frame, and the validator escalates it from warning to **error**.

The baker does not take the derivation on faith. It fully skins a strided
subset of frames through the vertex path and compares against the bone
reconstruction, reporting `maxReconstructionError` in the metadata and the
validation report. On a clean bind-pose character this lands at float noise.

`B_k` is decomposed into translation + quaternion. Scale is discarded — a
quaternion cannot carry it. The largest `|scale − 1|` seen anywhere in the bake
is reported as `maxScaleDeviation`, so squash-and-stretch rigs surface as a
warning rather than as mystery wrongness.

At rest `B_k = I`, so the stored translation is naturally zero-centred and the
stored quaternion is identity. No separate offset mode is needed, and RGBA16F is
comfortable for both textures.

---

## 2. Texture layout

Same linear addressing as vertex mode, with bones in place of vertices:

```
linearSample = globalFrame · boneCount + boneIndex
textureX     = linearSample % textureWidth
textureY     = floor(linearSample / textureWidth)
```

| Texture | Channels |
|---|---|
| `T_<Asset>_VAT_BonePos.exr` | RGB = translation of `B_k`, A = 1 |
| `T_<Asset>_VAT_BoneRot.exr` | RGBA = quaternion (x, y, z, w) of `B_k` |

Because bone counts are small, `Auto` width usually lands on a modest texture —
frequently a few hundred texels square. Sample counts stay far below the 2²⁴
fp32 exact-integer ceiling, but the shader still uses integer math for
consistency with vertex mode.

Quaternions are baked with **hemisphere continuity**: a quaternion and its
negation describe the same rotation, but `decompose()` can return either, and
interpolating across a sign flip sends the bone the long way around the sphere —
a visible one-frame spin. Each bone is kept in the same hemisphere as its
previous frame, and the shader also does a `dot < 0` check before its nlerp so it
is correct on its own terms.

---

## 3. Skin influences on the mesh

Bone mode does not address the texture per vertex, so there is no lookup UV.
Instead each vertex carries its four skin influences, packed two per UV set:

```
uv1 = ( idx0 + w0·0.99 , idx1 + w1·0.99 )
uv2 = ( idx2 + w2·0.99 , idx3 + w3·0.99 )

boneIndex = floor(packed)
weight    = frac(packed) / 0.99
```

Index and weight share one float because `GLTFExporter` only maps
`uv`/`uv1`/`uv2`/`uv3`, and UV0 has to stay available for real texture
coordinates. Four influences across two channels leaves one slot spare. The
`0.99` factor rather than `1.0` guarantees a weight of exactly 1 cannot carry
into the next integer.

fp32 gives roughly 14 bits to the fraction after a 10-bit bone index, so weight
precision is about 1/16000 — finer than the 8-bit weights most engines ship.
Verified round-trip error across 200,000 random index/weight pairs: **3.1e-5**.

**This makes "Use Full Precision UVs" mandatory in bone mode**, not merely
advisable. Half-precision UVs would destroy the packed fraction. The mesh
exporter emits this as a warning on every bone-mode bake so it cannot be missed.

---

## 4. Unreal material

Import both EXRs exactly as in [UNREAL_MATERIAL.md](./UNREAL_MATERIAL.md) §1 —
no sRGB, no mips, `Nearest`, `Clamp`. Import the GLB with **Use Full Precision
UVs on**.

Custom node inputs: `BonePosTex`, `BoneRotTex` (Texture Objects), `UV1`, `UV2`,
`AnimData` (float4 from the lookup texture), `Time`, `TexSize` (float2),
`BoneCount` (float). Output type `CMOT Float 3`.

```hlsl
// --- resolve the frame within the animation -----------------------------
float startFrame = AnimData.r;
float frameCount = AnimData.g;
float fps        = AnimData.b;
bool  looping    = AnimData.a > 0.5;

float localTime  = Time * fps;
float localFrame = looping
    ? fmod(localTime, frameCount)
    : min(localTime, frameCount - 1.0);

float globalFrameF = startFrame + localFrame;
uint  frameLo = (uint)floor(globalFrameF);
uint  frameHi = min(frameLo + 1u, (uint)(startFrame + frameCount - 1.0));
float blend   = globalFrameF - floor(globalFrameF);

uint width = (uint)TexSize.x;
uint bc    = (uint)BoneCount;

// --- blend four bone influences ------------------------------------------
float4 packed = float4(UV1.x, UV1.y, UV2.x, UV2.y);
float3 restPos = GetLocalPosition();   // or pass the rest position in explicitly
float3 acc  = 0;
float  wsum = 0;

[unroll]
for (int k = 0; k < 4; k++)
{
    float v     = packed[k];
    float boneF = floor(v);
    float w     = (v - boneF) / 0.99;
    if (w <= 0.0) continue;
    wsum += w;

    uint bone = (uint)boneF;
    uint linLo = frameLo * bc + bone;
    uint linHi = frameHi * bc + bone;

    int3 tLo = int3(linLo % width, linLo / width, 0);
    int3 tHi = int3(linHi % width, linHi / width, 0);

    float4 rA = BoneRotTex.Load(tLo);
    float4 rB = BoneRotTex.Load(tHi);
    if (dot(rA, rB) < 0.0) rB = -rB;          // hemisphere check before nlerp
    float4 rot = normalize(lerp(rA, rB, blend));

    float3 pA = BonePosTex.Load(tLo).rgb;
    float3 pB = BonePosTex.Load(tHi).rgb;
    float3 pos = lerp(pA, pB, blend);

    // quaternion rotate: v + 2·q.xyz × (q.xyz × v + q.w·v)
    float3 r = restPos + 2.0 * cross(rot.xyz, cross(rot.xyz, restPos) + rot.w * restPos);
    acc += w * (r + pos);
}

float3 skinned = (wsum > 1e-6) ? acc / wsum : restPos;

// --- axis fix-up, only when the bake used axisConversion = none ----------
float3 offset = skinned - restPos;
offset = float3(-offset.z, offset.x, offset.y);

return offset;
```

Wire the result into **World Position Offset**. Note that bone mode always
produces an offset from the rest position regardless of the position-mode
setting, because the mesh already holds the rest pose and the reconstruction
starts from it.

### Animated normals for free

The same blended quaternion rotates the rest normal — no second texture, no
extra address math:

```hlsl
float3 n = normalize(acc_normal / wsum);   // accumulate quatRotate(rot, restNormal)
```

Accumulate `w * quatRotate(rot, VertexNormalWS_or_local)` in the same loop.

### A note on axis conversion

**Bake with `axisConversion = none` when using bone mode.** The `glTF → Unreal`
option pre-swizzles channel order, which is correct for positions but *wrong for
quaternions* — reordering a quaternion's components produces a mirrored
rotation, not a basis change. The rotation EXR is therefore written unconverted
regardless of the setting, and the swizzle belongs in the material as shown
above.

---

## 5. When to use which mode

**Bone mode** when texture size is the constraint: large crowds, dense meshes,
many animations, memory-limited platforms. Also when you want animated normals
without a second texture.

**Vertex mode** when fidelity is the constraint: squash-and-stretch or any rig
with non-uniform bone scale, cloth or blendshape-driven detail that skinning
alone does not reproduce, a character whose rest pose is not its bind pose, or
anywhere you would rather pay disk than per-vertex shader cost.

Whichever mode you pick, check **Overlay** in the viewport before exporting. It
draws the skeletal mesh solid and the VAT-driven mesh as a green wireframe using
the actual baked textures and the actual decoder — including the full bone
reconstruction in bone mode. If the cage hugs the surface across the whole
timeline, the bake is sound.

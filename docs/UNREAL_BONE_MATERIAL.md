# Bone VAT — exact Unreal material setup

Step by step, from the four exported files to a working crowd material.

Assumes you baked with **VAT mode = Bone**. If you baked in vertex mode, use
[UNREAL_MATERIAL.md](./UNREAL_MATERIAL.md) instead — the address math differs.

---

## 0. Decide where the axis conversion happens

This is the single most important decision, and doing it in both places is the
most common way to end up with a character that animates convincingly and
wrongly.

glTF is Y-up right-handed; Unreal is Z-up left-handed. The glTF importer
converts the **mesh**. Nothing automatically converts the **texture values**.

Pick one:

| | Bake setting | Material work |
|---|---|---|
| **A — bake converted** (recommended) | Axis conversion = `glTF → Unreal` | none |
| **B — bake neutral** | Axis conversion = `none` | convert in HLSL |

**Path A is strongly recommended for bone mode**, because the conversion is not
a channel swizzle. The basis change

```
C : (x, y, z) → (−z, x, y)          det(C) = −1
```

is a *reflection*. Positions convert by applying `C` directly. Rotations
convert by conjugation, and because the axis of a rotation is an axial vector it
picks up `det(C)`:

```
C · R(axis, θ) · C⁻¹ = R( det(C) · C·axis , θ )

quaternion:  (x, y, z, w)  →  (z, −x, −y, w)
```

Applying the position swizzle `(−z, x, y, w)` to a quaternion instead produces a
**mirrored** rotation. Verified numerically: conjugation reproduces the directly
converted result exactly (error 0.0), while the naive swizzle diverges by up to
3.2 units on a unit-scale test — visible, but easy to mistake for a retargeting
problem rather than a basis bug.

The baker does this correctly on export when you choose `glTF → Unreal`. The
rest of this document assumes **Path A**, and flags the extra HLSL you'd need
for Path B at the end.

---

## 1. Import

**`T_<Asset>_VAT_BonePos.exr`** and **`T_<Asset>_VAT_BoneRot.exr`**

| Setting | Value |
|---|---|
| Compression Settings | `HDR (RGBA16F)` — or `HDR F32` if you baked RGBA32F |
| sRGB | **off** |
| Mip Gen Settings | `NoMipmaps` |
| Filter | `Nearest` |
| Tiling X / Y | `Clamp` |
| Never Stream | on |

Getting sRGB, mips, or filtering wrong here is the most common cause of a
character that explodes into confetti — the material reads interpolated or
gamma-corrected values instead of exact stored floats.

**`SM_<Asset>_VAT.glb`**

| Setting | Value |
|---|---|
| **Use Full Precision UVs** | **on — mandatory** |
| Generate Lightmap UVs | off |
| Import Animations | off |

Full precision UVs are not optional in bone mode. UV1 and UV2 carry bone index
and weight packed into a single float each; half precision destroys the
fractional weight and the mesh deforms wrong.

After import, open the mesh and raise **Bounds Scale** until it covers the
`bounds` block in the JSON. Otherwise Unreal culls using rest-pose bounds and
characters pop out of view mid-animation.

---

## 2. Determine the scale factor

The glTF importer scales the mesh; it does not scale your texture values. If the
importer converted metres to centimetres, mesh local positions are 100× the
units the bone translations are stored in, and the character will collapse or
explode by exactly that factor.

**Measure it rather than guessing.** Open the imported static mesh and read its
bounds from the asset editor, then compare against `bounds.size` in
`<Asset>_VAT.json`:

```
VATScale = (mesh bounds size in Unreal) / (bounds.size in the JSON)
```

Usually this is exactly `1` or exactly `100`. Make it a scalar material
parameter named `VATScale` so you can correct it without a rebake.

---

## 3. Material parameters

Create `M_<Asset>_VAT`. Set **Blend Mode** `Opaque`, **Shading Model**
`Default Lit`, and tick **Used with Instanced Static Meshes** plus **Used with
Niagara Mesh Particles**.

| Parameter | Type | Value |
|---|---|---|
| `BonePosTex` | Texture Object | `T_<Asset>_VAT_BonePos` |
| `BoneRotTex` | Texture Object | `T_<Asset>_VAT_BoneRot` |
| `LookupTex` | Texture Object | `T_<Asset>_VAT_Lookup` |
| `TexSize` | Vector2 (or two scalars) | `texture.width`, `texture.height` from the JSON |
| `BoneCount` | Scalar | `bone.boneCount` from the JSON |
| `AnimationCount` | Scalar | number of rows in the CSV |
| `VATScale` | Scalar | from step 2 |

---

## 4. Feed the animation state in

For a Niagara crowd, `AnimationID` and `Time` arrive as per-instance custom
data (wired up in step 6):

```
AnimationID = PerInstanceCustomData[0]
Time        = PerInstanceCustomData[1]
```

Sample the lookup texture with a `Texture Sample` node set to **Nearest**:

```
U = (AnimationID + 0.5) / AnimationCount
V = 0.5
```

Output is `float4(StartFrame, FrameCount, FPS, Flags)` — raw and unnormalised,
because the lookup texture is RGBA32F.

---

## 5. The Custom node

Add a `Custom` node, output type **CMOT Float 3**.

**Inputs** (names must match exactly):

| Pin | Wire from |
|---|---|
| `BonePosTex` | the `BonePosTex` parameter |
| `BoneRotTex` | the `BoneRotTex` parameter |
| `UV1` | `TexCoord[1]` |
| `UV2` | `TexCoord[2]` |
| `AnimData` | the lookup `Texture Sample` RGBA output |
| `Time` | `PerInstanceCustomData[1]` |
| `TexSize` | the `TexSize` parameter |
| `BoneCount` | the `BoneCount` parameter |
| `RestPos` | `WorldPosition` → `TransformPosition (World → Local)` |
| `VATScale` | the `VATScale` parameter |

`RestPos` needs the note: World Position Offset is evaluated *before* the offset
is applied, so `WorldPosition` at this point is the un-offset vertex, and
transforming it to local space gives the rest position the bake wrote into the
mesh. Using `ObjectPosition` or `ActorPosition` instead gives you the pivot, not
the vertex, and every vertex will collapse to a point.

```hlsl
// ---- resolve the frame within the animation -----------------------------
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

// ---- blend the four skin influences -------------------------------------
// UV1 = (idx0 + w0*0.99, idx1 + w1*0.99)
// UV2 = (idx2 + w2*0.99, idx3 + w3*0.99)
float4 packed  = float4(UV1.x, UV1.y, UV2.x, UV2.y);
float3 restPos = RestPos / VATScale;     // into the space the textures use
float3 acc     = 0;
float  wsum    = 0;

[unroll]
for (int k = 0; k < 4; k++)
{
    float v     = packed[k];
    float boneF = floor(v);
    float w     = (v - boneF) / 0.99;
    if (w <= 0.0) continue;
    wsum += w;

    uint bone  = (uint)boneF;
    uint linLo = frameLo * bc + bone;
    uint linHi = frameHi * bc + bone;

    int3 tLo = int3(linLo % width, linLo / width, 0);
    int3 tHi = int3(linHi % width, linHi / width, 0);

    // nlerp with a hemisphere check: q and -q are the same rotation, and
    // interpolating across a sign flip sends the bone the long way round,
    // which reads as a one-frame spin.
    float4 rA = BoneRotTex.Load(tLo);
    float4 rB = BoneRotTex.Load(tHi);
    if (dot(rA, rB) < 0.0) rB = -rB;
    float4 rot = normalize(lerp(rA, rB, blend));

    float3 pos = lerp(BonePosTex.Load(tLo).rgb, BonePosTex.Load(tHi).rgb, blend);

    // quaternion rotate: v + 2*q.xyz x (q.xyz x v + q.w*v)
    float3 r = restPos + 2.0 * cross(rot.xyz, cross(rot.xyz, restPos) + rot.w * restPos);
    acc += w * (r + pos);
}

float3 skinned = (wsum > 1e-6) ? (acc / wsum) : restPos;

// Back into Unreal mesh units, and return an OFFSET, since the mesh already
// holds the rest pose.
return (skinned * VATScale) - RestPos;
```

`Texture.Load` takes integer texel coordinates and bypasses filtering entirely,
so there is no half-texel rounding to get wrong. Integer address math matters
here for the same reason as vertex mode — keep it in `uint`.

**Wire the output into World Position Offset** through
`TransformVector (Local → World)`. WPO expects a world-space offset; the Custom
node returns a local-space one.

---

## 6. Animated normals (optional)

The same blended quaternion rotates the rest normal — no second texture and no
extra address math. Duplicate the Custom node, add a `RestNormal` input from
`VertexNormalWS` → `TransformVector (World → Local)`, and inside the loop
accumulate:

```hlsl
acc += w * (restNormal + 2.0 * cross(rot.xyz, cross(rot.xyz, restNormal) + rot.w * restNormal));
```

Return `normalize(acc / wsum)`, feed it through `TransformVector (Local →
World)`, and plug into the material's **Normal** input with **Tangent Space
Normal unchecked**.

Note there is no `VATScale` division here — a normal is a direction, not a
position.

---

## 7. Niagara

1. New Niagara System from an empty **GPU** emitter.
2. **Mesh Renderer** → mesh `SM_<Asset>_VAT`, material override `M_<Asset>_VAT`.
3. Add particle attributes `AnimID` (float) and `AnimStartTime` (float), set
   **On Spawn**:
   - `AnimID` = a floored random in `[0, AnimationCount)`, or your own selection logic
   - `AnimStartTime` = current engine time
4. In **Particle Update**, write into renderer **Custom Data**:
   ```
   CustomData.x = AnimID
   CustomData.y = Engine.Time - AnimStartTime
   ```

Randomising `AnimStartTime` per particle is what stops the whole crowd
animating in lockstep. It is the single highest-impact line in the whole setup
visually.

To switch animation mid-flight, set `AnimID` **and** reset `AnimStartTime` to
the current time in the same script, so the new clip starts at local frame 0
rather than inheriting the old clip's phase.

---

## 8. Nanite

Nanite does not support skeletal bone skinning, which is exactly why VAT exists
for crowds. A VAT character is a static mesh deformed entirely through WPO.

1. Enable **Nanite** on `SM_<Asset>_VAT`.
2. Enable **Evaluate World Position Offset** on the material (exact name varies
   by engine version — check your version's Nanite settings).
3. Know what you are trading:
   - Nanite's automatic geometric LOD stops applying once WPO is enabled.
   - Shadow and ray-tracing representations may not track WPO identically
     depending on version — watch for shadows that don't match the pose.
   - There is a WPO **distance threshold** that disables the offset past a
     certain camera range. Distant crowd members freezing into a rest-pose
     stance is this setting, not a bug in the bake.

Nanite + Niagara + WPO is more sensitive to engine-version specifics than
ordinary work, so verify on your exact UE version rather than trusting any
tutorial's defaults, including this one.

---

## Path B — converting in the material instead

Only if you baked with axis conversion `none`. Insert immediately after the two
`Load` calls, before anything uses `rot` or `pos`:

```hlsl
rot = float4(rot.z, -rot.x, -rot.y, rot.w);   // conjugation, NOT a swizzle
pos = float3(-pos.z, pos.x, pos.y);           // position basis change
```

and take `restPos` as `RestPos / VATScale` converted back into glTF space:

```hlsl
float3 restPos = float3(RestPos.y, RestPos.z, -RestPos.x) / VATScale;
```

then convert the final result forward again. This is more moving parts and more
chances to mirror something, which is why Path A exists.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| Confetti / vertices scattered | Full Precision UVs off, or texture filtering/mips/sRGB not set correctly |
| Character collapses to a point | `RestPos` wired from ObjectPosition/ActorPosition instead of `WorldPosition → TransformPosition` |
| Character is 100× too big or small | `VATScale` — measure it against the JSON bounds |
| Animates, but mirrored or twisted | Quaternion converted with the position swizzle, or converted twice |
| Rotated 90° | Axis conversion applied twice, or not at all |
| One-frame spins at random | Hemisphere check missing before the quaternion lerp |
| Whole crowd moves identically | `AnimStartTime` not randomised per particle |
| Squash/stretch missing | Expected — bone mode drops non-uniform scale. Check `maxScaleDeviation` in the JSON; use vertex mode if it matters |
| Distant characters freeze | Nanite WPO distance threshold |
| Wrong in engine, right in the baker | Trust the baker's Overlay view and re-check import settings first |

Before debugging Unreal at all, reopen the bake and check **Overlay** in the
viewport. It runs the real decoder against the real textures, including the full
bone reconstruction. If it's correct there, the problem is on the Unreal side.

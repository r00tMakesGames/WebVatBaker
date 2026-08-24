# Unreal material math

The chain the material has to reproduce:

```
AnimationID
  -> StartFrame, FrameCount, FPS, Flags        (lookup texture or DataTable)
  -> LocalAnimationTime -> LocalFrame
  -> GlobalFrame = StartFrame + LocalFrame
  -> VertexIndex        (from UV1)
  -> linear sample      = GlobalFrame * VertexCount + VertexIndex
  -> texture address    = (linear % Width, linear / Width)
  -> position offset    -> World Position Offset
```

---

## 1. Import settings that matter

**Position / normal EXR**

| Setting              | Value                                        |
|----------------------|----------------------------------------------|
| Compression Settings | `HDR (RGBA16F)` or `HDR F32` to match the bake |
| sRGB                 | off                                          |
| Mip Gen Settings     | `NoMipmaps`                                  |
| Filter               | `Nearest`                                    |
| Tiling X / Y         | `Clamp`                                      |
| Never Stream         | on                                           |

**Static mesh GLB**

| Setting                | Value                                       |
|------------------------|---------------------------------------------|
| Use Full Precision UVs | on (safest, though split = 1024 works without it) |
| Generate Lightmap UVs  | off                                         |
| Remove Degenerates     | off                                         |
| Bounds Scale           | large enough to cover the animated bounds from the metadata |

The `bounds` block in the JSON is exactly what the bounds scale has to cover;
without it Unreal will cull the mesh using its rest-pose bounds and characters
will pop out of view mid-animation.

---

## 2. Axis conversion

Three.js and glTF are Y-up right-handed; Unreal is Z-up left-handed. The glTF
importer converts the **mesh**, but nothing converts the **texture values**, so
one of the two has to happen:

- Bake with `Axis conversion = glTF → Unreal`. The EXR is written pre-swizzled
  and the material needs no fix-up. The metadata records
  `"axisConversion": "gltf_to_unreal"`.
- Bake with `none` (default, engine-independent) and swizzle in the material:

```
UnrealOffset = float3(-vat.z, vat.x, vat.y)
```

Multiply by 100 as well if the source was authored in metres.

---

## 3. Custom HLSL node

Integer math is not optional. `GlobalFrame * VertexCount + VertexIndex` exceeds
the exact-integer range of fp32 on any reasonably sized crowd asset, so the
address has to be computed with `uint`. Material graph nodes are float-only;
a `Custom` node is the reliable route.

Inputs: `PosTex` (Texture Object), `UV1` (TexCoord[1]), `AnimData` (float4 from
the lookup texture), `Time` (float), `TexSize` (float2), `VertexCount` (float),
`LookupSplit` (float). Output type `CMOT Float 3`.

```hlsl
// --- decode the vertex's VAT sample index -------------------------------
uint vertexIndex = (uint)(UV1.x + 0.5) + (uint)(UV1.y + 0.5) * (uint)LookupSplit;

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

// --- linear address -> texel ---------------------------------------------
uint  width = (uint)TexSize.x;
uint  vc    = (uint)VertexCount;

uint  linearLo = frameLo * vc + vertexIndex;
uint  linearHi = frameHi * vc + vertexIndex;

float3 a = PosTex.Load(int3(linearLo % width, linearLo / width, 0)).rgb;
float3 b = PosTex.Load(int3(linearHi % width, linearHi / width, 0)).rgb;

float3 offset = lerp(a, b, blend);

// --- axis fix-up, only when the bake used axisConversion = none ----------
offset = float3(-offset.z, offset.x, offset.y);

return offset;
```

`Texture.Load` takes integer texel coordinates and skips filtering entirely, so
there is no half-texel rounding to get wrong. If you would rather sample by UV,
the equivalent is:

```hlsl
float2 uv = (float2(linearLo % width, linearLo / width) + 0.5) / TexSize;
float3 a  = PosTex.SampleLevel(PosTexSampler, uv, 0).rgb;
```

Wire the result into **World Position Offset**. In `offset` mode that is the
whole story: the mesh already holds the rest pose, and the VAT supplies the
displacement. In `absolute` mode use
`WPO = offset - GetLocalPosition()` transformed to world space instead.

---

## 4. Animated normals

Same address, different texture, and the sample is a direction rather than a
displacement:

```hlsl
float3 n = normalize(lerp(nA, nB, blend));
n = float3(-n.z, n.x, n.y);           // if axisConversion = none
```

Feed it through a `Transform Vector` node from local to tangent space and into
the material's Normal input. Enable **Tangent Space Normal = false** and plug
into the world-space normal instead if that is simpler for your setup.

---

## 5. Getting AnimationID into the material

**Niagara GPU crowds.** Write the ID into a particle attribute and expose it as
per-instance custom data, then read it with `PerInstanceCustomData`:

```
AnimationID = PerInstanceCustomData[0]
Time        = PerInstanceCustomData[1]   // per-agent phase offset
```

Sample the lookup texture at

```
u = (AnimationID + 0.5) / AnimationCount
v = 0.5
```

with `Nearest` filtering, which yields `float4(StartFrame, FrameCount, FPS, Flags)`
directly — no normalization, because the texture is RGBA32F.

**DataTable route.** Import `<Asset>_VAT_Animations.csv` into a DataTable whose
row struct is:

| Column         | Type   |
|----------------|--------|
| Index          | int32  |
| Name           | FName  |
| StartFrame     | int32  |
| EndFrame       | int32  |
| FrameCount     | int32  |
| FPS            | float  |
| Duration       | float  |
| Loop           | bool   |
| SourceFilename | FString|

Blueprint or C++ then pushes `StartFrame`, `FrameCount` and `FPS` into material
parameters. This is the better route for a handful of hero actors; the lookup
texture is the better route for thousands of GPU particles.

---

## 6. Checklist when the result looks wrong

| Symptom | Likely cause |
|---------|--------------|
| Mesh explodes into confetti | vertex index decode is wrong — check `LookupSplit` and that UV1 survived import |
| Animation plays but is rotated 90° | axis conversion applied twice, or not at all |
| Motion is subtly jittery on large characters | RGBA16F with `absolute` positions; rebake as `offset` or RGBA32F |
| Character freezes at one pose | `Time` is not advancing, or the lookup texture was imported with sRGB / mips on |
| Animation drifts to the wrong clip over time | `linearSample` computed in float; move it into a `Custom` node with `uint` |
| Character vanishes at screen edges | bounds scale too small for the animated bounds in the JSON |

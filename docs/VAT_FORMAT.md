# VAT format

Version 1. Deterministic, engine-independent, and fully described by the JSON
sidecar written next to every bake.

---

## 1. Coordinate space

Every position and normal is expressed in **VAT object space**, defined as:

```
objectSpace = unitScale * meshWorldMatrix * skinnedLocalPosition
```

where `meshWorldMatrix` is the skinned mesh's world matrix relative to the FBX
root, and the root is pinned at the origin with identity rotation and scale on
import. `unitScale` is a user setting (default `1`).

The exported static mesh is generated from the same evaluation, so the mesh and
the textures can never drift apart. No axis conversion is applied unless
`axisConversion` says otherwise; see [UNREAL_MATERIAL.md](./UNREAL_MATERIAL.md).

---

## 2. Global frame indexing

Frames are **zero-based** and `endFrame` is **inclusive**:

```
frameCount = endFrame - startFrame + 1
```

Clips are laid out back to back in list order, and the list order *is* the
animation ID:

```
ID  Name       Start   End   Frames
0   Idle           0    59      60
1   Dance_A       60   149      90
2   Dance_B      150   229      80
3   Jump         230   259      30
```

Frame count per clip depends on whether it loops:

| Loop | Frame count            | Reason                                    |
|------|------------------------|-------------------------------------------|
| yes  | `round(d * fps)`       | frame N would duplicate frame 0, so it is dropped |
| no   | `round(d * fps) + 1`   | the final pose must be reachable          |

A local frame is evaluated at the exact time

```
t = min(localFrame / bakeFPS, clipDuration)
```

The animation is evaluated by writing that absolute time to the action and
updating the mixer with a zero delta. No realtime stepping, no accumulated
float drift; the same inputs always produce the same texels.

---

## 3. Texture addressing

Linear, not row-per-frame. A frame is allowed to straddle a row boundary.

```
linearSample = globalFrame * vertexCount + vertexIndex
textureX     = linearSample % textureWidth
textureY     = floor(linearSample / textureWidth)
```

```
totalSamples  = vertexCount * totalFrames
textureHeight = ceil(totalSamples / textureWidth)
```

Width is chosen from `1024 / 2048 / 4096 / 8192 / 16384`, or `Auto`, which picks
the narrowest power-of-two width that is still at least as wide as it is tall.
That caps padding at one row and avoids degenerate slivers. If no width keeps
the height inside the device limit, the bake fails with an explicit message
instead of silently truncating.

Unused trailing texels are zero. Row 0 of the texture is row 0 of the EXR (EXR
scanlines are written top-down, `lineOrder = INCREASING_Y`), so no V flip is
needed in any engine whose texture origin is top-left.

**Integer precision matters.** `linearSample` passes 2^24 — the exact-integer
ceiling of fp32 — at roughly 20k vertices × 840 frames. Address math must be
done in integers. The bundled GLSL decoder uses `int`/`texelFetch`; the Unreal
snippet uses a `Custom` HLSL node with `uint`.

---

## 4. Channels and precision

| Channel | Position texture       | Normal texture                |
|---------|------------------------|-------------------------------|
| R       | X                      | normal X                      |
| G       | Y                      | normal Y                      |
| B       | Z                      | normal Z                      |
| A       | 1                      | 1                             |

Formats: `RGBA16F` (default) or `RGBA32F`. Linear data, no gamma, no sRGB
encoding, no mip maps, point sampling only.

Position mode:

- **`offset`** (default) — stored value is `animated - restPose`. Small
  magnitudes, which is what makes RGBA16F safe. Runtime position is
  `restPosition + sampledOffset`.
- **`absolute`** — stored value is the animated object-space position. Runtime
  position is the sample itself, and the rest pose in the mesh is ignored.

Half floats step by more than one unit above 2048, so the baker warns when the
largest stored magnitude crosses that line.

Normals are always stored as raw unit-length object-space vectors in −1..1, even
in offset mode. They are not offsets.

---

## 5. VAT lookup UV

Importers may reorder, split, or weld vertices, so mesh vertex order cannot be
trusted to address the texture. The sample index travels with the vertex in a
second UV set (`uv1` → glTF `TEXCOORD_1` → Unreal UV channel 1):

```
uv1.x = vertexIndex % split
uv1.y = floor(vertexIndex / split)

vertexIndex = round(uv1.x) + round(uv1.y) * split
```

`split` defaults to **1024**. Half-precision floats represent integers exactly
only up to 2048, and Unreal stores UVs as half unless *Use Full Precision UVs*
is enabled, so both components stay exactly representable for meshes up to about
one million vertices. Enabling full-precision UVs on import is still recommended.

A useful side effect: the lookup value is unique per vertex, so no importer can
weld two VAT vertices into one.

UV0 is never overwritten. Any additional source UV sets are shifted up one slot
and the shift is reported in the log.

---

## 6. Animation lookup texture

`RGBA32F`, `animationCount x 1`, one texel per animation ID, values raw and
unnormalized:

| Channel | Value                |
|---------|----------------------|
| R       | StartFrame           |
| G       | FrameCount           |
| B       | FPS                  |
| A       | Flags, bit 0 = loop  |

A Niagara particle then only has to carry an `AnimationID`; the material reads
everything else out of this texture.

---

## 7. Files

For a base file `SK_Club_Male01.fbx`:

```
SM_Club_Male01_VAT.glb            rest-pose static mesh + VAT lookup UV
T_Club_Male01_VAT_Pos.exr         position VAT
T_Club_Male01_VAT_Nrm.exr         normal VAT (optional)
T_Club_Male01_VAT_Lookup.exr      animation lookup (optional)
Club_Male01_VAT.json              metadata
Club_Male01_VAT_Animations.csv    DataTable rows
Club_Male01_VAT_Validation.txt    validation report
```

See [sample_metadata.json](./sample_metadata.json) and
[sample_animations.csv](./sample_animations.csv), both generated by the real
code paths rather than written by hand.

---

## 8. Determinism

Given the same base FBX, the same animation FBX files in the same order, and the
same settings, the baker always produces byte-identical IDs, frame ranges,
texture dimensions, and texel values:

- IDs and ranges are regenerated from list order on every mutation, never patched.
- Clips are evaluated at absolute times, never by accumulating deltas.
- Every bone is reset to its authored rest transform before each sample, so a
  clip that animates only part of the skeleton cannot inherit state from the
  previous frame or the previous clip.
- Texture width is a pure function of vertex count, frame count, and settings.

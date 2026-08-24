# VAT Baker

Bakes skeletal FBX animation into Vertex Animation Textures in the browser. No
backend, no upload — the FBX files never leave the machine.

Built for Unreal Engine static-mesh VAT playback and Niagara GPU crowds, but the
format itself is engine-independent and fully documented.

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Requires WebGL2 (the decoder uses `texelFetch`
and integer address math).

```bash
npm run build      # typecheck + production bundle
npm run typecheck  # types only
```

---

## What it does

1. Drop one base character FBX — skinned mesh, skeleton, skin weights, bind pose.
2. Drop any number of animation FBX files for the same skeleton. Track names are
   normalized and remapped onto the base skeleton by bone name.
3. Preview the character and any clip in the viewport.
4. Reorder clips by dragging rows. Row order **is** the animation ID, and IDs,
   start frames, end frames and the atlas total are regenerated on every change.
5. Pick a bake mode — **vertex** (a position per vertex per frame) or **bone**
   (a transform per bone per frame, typically 100x smaller). See
   [docs/VAT_BONE_MODE.md](docs/VAT_BONE_MODE.md).
6. Bake all clips sequentially into one VAT atlas.
7. Switch the viewport to **VAT** or **Overlay** to confirm the texture drives
   the same motion as the skeleton.
8. Export EXR textures, a rest-pose GLB, metadata JSON, a DataTable CSV, and a
   validation report.

Identical inputs and settings produce identical output. See
[docs/VAT_FORMAT.md](docs/VAT_FORMAT.md) §8.

---

## Hosting on GitHub Pages

The app is entirely client-side — no server, no API, no upload. FBX files are
parsed in the browser and never leave the machine, so a static host is all it
needs.

1. Push the project to a GitHub repository.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Push to `main`. The included workflow at `.github/workflows/deploy.yml`
   builds and publishes automatically.

The site lands at `https://<user>.github.io/<repo>/`.

The one thing that needs care is the base path. Pages serves a project site from
a subdirectory, so asset URLs need that prefix or the page loads blank with 404s
on the JS bundle. The workflow passes the repo name through `VITE_BASE`, and
`vite.config.ts` reads it, so nothing is hard-coded and local dev is unaffected.
For a user/organisation site (`<user>.github.io`), drop the `VITE_BASE` line
from the workflow — such sites are served from the root.

To build for Pages by hand instead:

```bash
VITE_BASE=/your-repo-name/ npm run build   # writes dist/
```

Note that Pages serves over HTTPS, which WebGL2 is happy with. There is no COOP
or COEP requirement, since the baker uses no `SharedArrayBuffer`.

## Layout

The work area is resizable. Drag the divider between the left column and the
preview to widen it, or the dividers in the left stack to trade height between
panels. Double-click any divider to reset. **Focus** in the preview header fills
the window with the viewport; Escape or the same button restores the layout.
Sizes persist between sessions.

## Documentation

| Document | Contents |
|----------|----------|
| [docs/VAT_FORMAT.md](docs/VAT_FORMAT.md) | Coordinate space, frame indexing, texture addressing, channels, lookup UV, determinism |
| [docs/VAT_BONE_MODE.md](docs/VAT_BONE_MODE.md) | Bone VAT: the derivation, influence packing, and its Unreal material |
| [docs/UNREAL_MATERIAL.md](docs/UNREAL_MATERIAL.md) | Import settings, HLSL `Custom` node, Niagara wiring, troubleshooting |
| [docs/sample_metadata.json](docs/sample_metadata.json) | Real output of `buildMetadata()` |
| [docs/sample_animations.csv](docs/sample_animations.csv) | Real output of `metadataToCSV()` |

---

## Architecture

The baking engine has no React or DOM dependencies. React reads plain values out
of a small external store; Three.js objects live in a module-scoped session and
never enter component state.

```
src/
  vat/                      the engine — no React, no DOM
    types.ts                shared contracts
    FBXImporter.ts          parse, locate the SkinnedMesh, validate, detect source FPS
    SkeletonMatcher.ts      bone-name normalization, track retargeting, compatibility
    AnimationLibrary.ts     IDs, frame counts, global ranges, reordering
    AnimationSampler.ts     deterministic clip evaluation
    SkinEvaluator.ts        allocation-free CPU skinning
    VATPacker.ts            texture layout, addressing, bounds, lookup texture
    Baker.ts                orchestration, progress, cancellation
    VATMetadata.ts          JSON + CSV
    MeshExporter.ts         VAT lookup UV, rest-pose geometry, GLB
    EXRWriter.ts            dependency-free OpenEXR writer
    Validation.ts           pre- and post-bake reports
    naming.ts               output-name derivation

  shaders/vatPreview.ts     GLSL 3.00 ES VAT decoder
  viewport/Viewport.ts      WebGL context, camera, render loop
  state/                    store, session actions, playhead
  components/               UI only
```

---

## Notable implementation choices

**Skinning is folded per bone, not per vertex.** Once per frame each bone's full
transform into VAT object space is collapsed into one matrix:

```
M_i = unitScale * meshWorld * bindMatrixInverse * (boneWorld_i * boneInverse_i) * bindMatrix
```

This is what `SkinnedMesh.applyBoneTransform()` computes, with the per-vertex
constants hoisted out. Skinning is linear in the bone matrices, so the vertex
loop just accumulates a weighted sum of the 12 affine elements and applies it —
no `Vector3`, no `Matrix4`, no allocation inside the loop.

**Sampling never uses delta time.** Each sample restores every bone to its
authored rest transform, writes the absolute action time, and updates the mixer
with a zero delta. That resets bones the clip does not touch (otherwise they
inherit the previous clip's pose) and sidesteps the paused/finished state a
`LoopOnce` action enters once it passes its duration — a trap `mixer.setTime()`
walks straight into.

**Rest positions come from the skinner, not from the geometry.** The rest pose is
evaluated through the same code path as every animated frame, so
`offset = animated - rest` is exactly zero at rest even when a file's authored
pose differs from its bind pose. That deviation is measured and reported rather
than silently absorbed.

**Address math is integer.** `globalFrame * vertexCount + vertexIndex` passes
2^24 at roughly 20k vertices × 840 frames, where fp32 stops representing
consecutive integers. The GLSL decoder uses `int` and `texelFetch`; the Unreal
snippet uses `uint`.

**The EXR writer is hand-rolled.** ~200 lines producing uncompressed scanline
RGBA EXR with HALF or FLOAT channels. No dependency on which `EXRExporter`
overload a given Three release ships, no `WebGLRenderTarget` round trip, and the
axis conversion folds into the same pass. Validated by parsing the output back
with an independent reader.

**Baking yields instead of threading.** `FBXLoader`, `AnimationMixer` and
`Skeleton` are main-thread objects and are not structured-cloneable, so a Web
Worker would have to re-parse the FBX on the other side. The loop yields to the
event loop about every 14 ms instead, which keeps the UI responsive, keeps
progress live, and makes cancellation immediate. Moving to a worker would mean
reimplementing FBX parsing worker-side — worth doing, but not before correctness.

---

## GLSL VAT decoder

The full shader is [`src/shaders/vatPreview.ts`](src/shaders/vatPreview.ts). The
decoding core:

```glsl
uniform sampler2D vatPosition;
uniform int   vatTexWidth;
uniform int   vatVertexCount;
uniform int   vatLookupSplit;
uniform int   vatFrameLo;
uniform int   vatFrameHi;
uniform float vatFrameBlend;
uniform int   vatPositionMode;   // 0 = absolute, 1 = offset from rest

in vec3 position;   // rest pose
in vec2 uv1;        // VAT lookup

int vatVertexIndex() {
  return int(uv1.x + 0.5) + int(uv1.y + 0.5) * vatLookupSplit;
}

vec3 vatFetch(sampler2D tex, int frame, int vertexIndex) {
  int linear = frame * vatVertexCount + vertexIndex;
  ivec2 texel = ivec2(linear % vatTexWidth, linear / vatTexWidth);
  return texelFetch(tex, texel, 0).xyz;
}

void main() {
  int vi = vatVertexIndex();
  vec3 sampled = mix(
    vatFetch(vatPosition, vatFrameLo, vi),
    vatFetch(vatPosition, vatFrameHi, vi),
    vatFrameBlend
  );
  vec3 p = (vatPositionMode == 1) ? position + sampled : sampled;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
```

**Overlay mode is the real test.** It draws the skeletal mesh solid and the
VAT-driven mesh as a green wireframe at the same transform. If the cage hugs the
surface through the whole timeline, the bake is correct. If it lags, drifts, or
scrambles, it is wrong — and which of those it does tells you where to look.

---

## Validation

Before baking: base character present, skinned mesh, skeleton, skin indices and
weights, stable vertex count, every clip compatible, unique names, sequential
IDs, frame count above zero, texture within device limits, RAM estimate.

After baking: sample count equals `vertexCount * totalFrames`, every range
inside the atlas, no overlaps, no unintended gaps, sufficient texel capacity, all
values finite, no NaN, non-degenerate bounds, bind-pose deviation, half-float
range warning.

Both reports appear in the Output panel and export as a text file.

---

## Known limitations

- Only the densest `SkinnedMesh` in the base file is baked. Additional skinned
  meshes are listed in the log and skipped.
- Morph targets are ignored.
- Bone mode discards non-uniform bone scale (a quaternion cannot carry it) and
  assumes the rest pose is the bind pose. Both conditions are measured and
  reported rather than assumed — see `maxScaleDeviation` and `restDeviation`.
- FBX geometry is usually non-indexed, so tangents cannot be computed and are
  left to the target engine (Unreal generates MikkTSpace tangents on import).
- Texture references inside the FBX resolve to an inline white pixel, and
  material maps are stripped from the GLB. Material names, colours and slot
  assignments survive.
- Normalized encoding is not implemented. `bounds` and `storedValueRange` are
  written to the metadata specifically so it can be added without a format break.
- Baking runs on the main thread (see above).

---

## Milestone status

| # | Milestone | State |
|---|-----------|-------|
| 1 | Load base FBX, inspect skeleton, preview | done |
| 2 | Load animation FBX, retarget by bone name, preview | done |
| 3 | Sample one animation, skin vertices, generate position VAT | done |
| 4 | VAT shader preview proving output matches skeletal animation | done |
| 5 | Multiple clips, global frame ranges | done |
| 6 | Export EXR + JSON + CSV | done |
| 7 | Export static VAT-ready GLB with lookup UV | done |
| 8 | Normals, lookup texture, UI | done except the worker |

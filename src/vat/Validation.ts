import type { BaseCharacter } from './FBXImporter';
import { computeLayout, TextureCapacityError } from './VATPacker';
import { estimateBakeMemory, formatBytes } from './Baker';
import { totalFrames as sumFrames } from './AnimationLibrary';
import type { BakeResult, BakeSettings, VATAnimation } from './types';

export type IssueLevel = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  level: IssueLevel;
  code: string;
  message: string;
}

export interface ValidationReport {
  stage: 'pre-bake' | 'post-bake';
  ok: boolean;
  generatedAt: string;
  issues: ValidationIssue[];
}

function report(stage: ValidationReport['stage'], issues: ValidationIssue[]): ValidationReport {
  return {
    stage,
    ok: !issues.some((i) => i.level === 'error'),
    generatedAt: new Date().toISOString(),
    issues,
  };
}

export function validatePreBake(
  character: BaseCharacter | null,
  animations: VATAnimation[],
  settings: BakeSettings,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const push = (level: IssueLevel, code: string, message: string) =>
    issues.push({ level, code, message });

  if (!character) {
    push('error', 'NO_BASE', 'No base character loaded.');
    return report('pre-bake', issues);
  }

  const geometry = character.mesh.geometry;
  if (!character.mesh.isSkinnedMesh) push('error', 'NO_SKINNED_MESH', 'Base mesh is not skinned.');
  if (!character.skeleton || character.skeleton.bones.length === 0) {
    push('error', 'NO_SKELETON', 'Base character has no skeleton.');
  }
  if (character.vertexCount === 0) push('error', 'NO_VERTICES', 'Base mesh has 0 vertices.');
  if (!geometry.getAttribute('skinIndex')) push('error', 'NO_SKIN_INDEX', 'Missing skinIndex.');
  if (!geometry.getAttribute('skinWeight')) push('error', 'NO_SKIN_WEIGHT', 'Missing skinWeight.');
  if (geometry.getAttribute('position').count !== character.vertexCount) {
    push('error', 'TOPOLOGY_CHANGED', 'Vertex count changed since import. Reload the base FBX.');
  }

  if (animations.length === 0) {
    push('error', 'NO_ANIMATIONS', 'No animations loaded.');
  }

  for (const a of animations) {
    if (a.compatibility === 'error') {
      push('error', 'INCOMPATIBLE', `"${a.name}" is incompatible: ${a.compatibilityNote}`);
    } else if (a.compatibility === 'warning') {
      push('warning', 'PARTIAL_MATCH', `"${a.name}": ${a.compatibilityNote}`);
    }
    if (a.frameCount <= 0) {
      push('error', 'EMPTY_RANGE', `"${a.name}" resolves to 0 frames at ${settings.bakeFPS} FPS.`);
    }
    if (a.sourceFPS && a.sourceFPS > settings.bakeFPS * 1.5) {
      push(
        'warning',
        'DOWNSAMPLING',
        `"${a.name}" was authored at ${a.sourceFPS} FPS and will be resampled to ${settings.bakeFPS} FPS.`,
      );
    }
  }

  const names = animations.map((a) => a.name.toLowerCase());
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    push('error', 'DUPLICATE_NAMES', `Duplicate animation names: ${[...new Set(dupes)].join(', ')}`);
  }

  animations.forEach((a, i) => {
    if (a.id !== i) push('error', 'NON_SEQUENTIAL_ID', `Animation "${a.name}" has ID ${a.id} at row ${i}.`);
  });

  const frames = sumFrames(animations);
  if (frames <= 0) {
    push('error', 'NO_FRAMES', 'Total frame count is 0.');
  } else {
    try {
      const boneMode = settings.vatMode === 'bone';
      const boneCount = character.skeleton?.bones.length ?? 0;
      if (boneMode && boneCount === 0) {
        push('error', 'NO_BONES', 'Bone mode needs a skeleton, but none was found.');
      }
      const layout = computeLayout(
        boneMode ? boneCount : character.vertexCount,
        frames,
        settings.textureWidth,
        settings.maxTextureDimension,
      );
      push(
        'info',
        'LAYOUT',
        `Texture ${layout.width} x ${layout.height}, ${layout.usedSamples.toLocaleString()} samples, ` +
          `${layout.wastedSamples.toLocaleString()} padding texels.`,
      );
      if (boneMode) {
        const vertexBytes = character.vertexCount * frames * 8;
        const boneBytes = boneCount * frames * 8 * 2;
        push(
          'info',
          'BONE_MODE',
          `Bone mode: ${boneCount} bones instead of ${character.vertexCount.toLocaleString()} vertices. ` +
            `Textures ~${formatBytes(boneBytes)} at RGBA16F, versus ~${formatBytes(vertexBytes)} for vertex mode.`,
        );
        if (settings.bakeNormals) {
          push(
            'info',
            'BONE_NORMALS',
            'Normal texture skipped: bone mode rotates the rest normal by the same blended quaternion at runtime.',
          );
        }
      }
      const mem = estimateBakeMemory(
        character.vertexCount,
        frames,
        settings.bakeNormals,
        boneMode ? boneCount : 0,
      );
      if (mem > 1_500_000_000) {
        push('error', 'MEMORY', `Bake needs about ${formatBytes(mem)} of RAM. Reduce FPS or frames.`);
      } else if (mem > 500_000_000) {
        push('warning', 'MEMORY', `Bake needs about ${formatBytes(mem)} of RAM.`);
      }
    } catch (err) {
      const message = err instanceof TextureCapacityError ? err.message : String(err);
      push('error', 'TEXTURE_LIMIT', message);
    }
  }

  if (settings.bakeFPS <= 0 || !Number.isFinite(settings.bakeFPS)) {
    push('error', 'BAD_FPS', 'Bake FPS must be greater than 0.');
  }
  if (settings.precision === 'RGBA16F' && settings.positionMode === 'absolute') {
    push(
      'warning',
      'HALF_ABSOLUTE',
      'RGBA16F with absolute positions loses precision on large characters. Offset mode or RGBA32F is safer.',
    );
  }

  return report('pre-bake', issues);
}

export function validatePostBake(result: BakeResult): ValidationReport {
  const issues: ValidationIssue[] = [];
  const push = (level: IssueLevel, code: string, message: string) =>
    issues.push({ level, code, message });

  const addressed = result.bone ? result.bone.boneCount : result.vertexCount;
  const expected = addressed * result.totalFrames;
  if (result.layout.usedSamples !== expected) {
    push(
      'error',
      'SAMPLE_COUNT',
      `Sample count mismatch: layout claims ${result.layout.usedSamples}, expected ${expected}.`,
    );
  } else {
    push('info', 'SAMPLE_COUNT', `${expected.toLocaleString()} samples written.`);
  }

  if (result.layout.capacity < expected) {
    push('error', 'CAPACITY', 'Texture has fewer texels than samples.');
  }

  let cursor = 0;
  for (const r of result.ranges) {
    if (r.startFrame !== cursor) {
      push(
        r.startFrame < cursor ? 'error' : 'warning',
        r.startFrame < cursor ? 'RANGE_OVERLAP' : 'RANGE_GAP',
        `"${r.name}" starts at ${r.startFrame}, expected ${cursor}.`,
      );
    }
    if (r.endFrame - r.startFrame + 1 !== r.frameCount) {
      push('error', 'RANGE_MATH', `"${r.name}" frame count does not match its inclusive range.`);
    }
    if (r.endFrame >= result.totalFrames || r.startFrame < 0) {
      push('error', 'RANGE_BOUNDS', `"${r.name}" range falls outside 0..${result.totalFrames - 1}.`);
    }
    cursor = r.endFrame + 1;
  }
  if (cursor !== result.totalFrames) {
    push('error', 'TOTAL_MISMATCH', `Ranges cover ${cursor} frames but the atlas holds ${result.totalFrames}.`);
  }

  if (result.nanCount > 0) {
    push('error', 'NAN', `${result.nanCount} non-finite position components were generated.`);
  }

  // Spot-check the written buffer rather than trusting the counter alone.
  let nonFinite = 0;
  const step = Math.max(1, Math.floor(expected / 250_000));
  for (let s = 0; s < expected; s += step) {
    const o = s * 4;
    if (
      !Number.isFinite(result.positions[o]) ||
      !Number.isFinite(result.positions[o + 1]) ||
      !Number.isFinite(result.positions[o + 2])
    ) {
      nonFinite++;
    }
  }
  if (nonFinite > 0) push('error', 'NON_FINITE', `${nonFinite} sampled texels are not finite.`);

  const size = result.bounds.size;
  if (size[0] === 0 && size[1] === 0 && size[2] === 0) {
    push('warning', 'ZERO_BOUNDS', 'Animated bounds are degenerate. The mesh may not be deforming.');
  }

  if (result.restDeviation > 1e-3) {
    // In vertex mode this is cosmetic. In bone mode the whole derivation of
    // B_k = M_k * F^-1 assumes rest == bind, so it is the error bound.
    push(
      result.bone ? 'error' : 'warning',
      'BIND_POSE',
      `Skinned rest pose deviates from the raw bind-pose geometry by up to ${result.restDeviation.toFixed(4)} units. ` +
        (result.bone
          ? 'Bone mode assumes the rest pose IS the bind pose; this deviation propagates into every frame. ' +
            'Re-export the character from its bind pose, or use vertex mode.'
          : 'The file was probably authored in a pose other than its bind pose; VAT offsets remain correct, but check the mesh visually.'),
    );
  }

  if (result.bone) {
    const b = result.bone;
    const extent = Math.max(...result.bounds.size, 1e-6);
    const relative = b.maxReconstructionError / extent;
    if (relative > 0.01) {
      push(
        'error',
        'BONE_RECONSTRUCTION',
        `Bone reconstruction differs from true vertex skinning by up to ${b.maxReconstructionError.toFixed(4)} units ` +
          `(${(relative * 100).toFixed(2)}% of the animated extent). Bone mode is not faithful for this asset.`,
      );
    } else if (relative > 0.001) {
      push(
        'warning',
        'BONE_RECONSTRUCTION',
        `Bone reconstruction differs from true vertex skinning by up to ${b.maxReconstructionError.toFixed(4)} units ` +
          `(${(relative * 100).toFixed(3)}% of the animated extent). Check the Overlay preview.`,
      );
    } else {
      push(
        'info',
        'BONE_RECONSTRUCTION',
        `Bone reconstruction matches vertex skinning to within ${b.maxReconstructionError.toFixed(6)} units.`,
      );
    }

    if (b.maxScaleDeviation > 0.01) {
      push(
        'warning',
        'BONE_SCALE',
        `Bones scale by up to ${(b.maxScaleDeviation * 100).toFixed(1)}% during the animation. ` +
          'A quaternion cannot carry scale, so squash and stretch is lost in bone mode. Use vertex mode to keep it.',
      );
    }

    if (b.boneCount > 1024) {
      push(
        'warning',
        'BONE_COUNT',
        `${b.boneCount} bones: the packed influence encoding gives the bone index 10 bits before weight precision suffers.`,
      );
    }
  }

  if (result.settings.precision === 'RGBA16F') {
    const worst = Math.max(
      ...result.storedBounds.min.map(Math.abs),
      ...result.storedBounds.max.map(Math.abs),
    );
    if (worst > 2048) {
      push(
        'warning',
        'HALF_RANGE',
        `Largest stored magnitude is ${worst.toFixed(1)}. Half floats step by more than 1 unit above 2048; consider RGBA32F.`,
      );
    }
  }

  return report('post-bake', issues);
}

export function reportToText(reports: ValidationReport[]): string {
  const lines: string[] = ['VAT Baker validation report', ''];
  for (const r of reports) {
    lines.push(`== ${r.stage} (${r.generatedAt}) — ${r.ok ? 'PASS' : 'FAIL'}`);
    if (r.issues.length === 0) lines.push('  no issues');
    for (const i of r.issues) lines.push(`  [${i.level.toUpperCase()}] ${i.code}: ${i.message}`);
    lines.push('');
  }
  return lines.join('\n');
}

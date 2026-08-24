import type { Bounds, TextureLayout, WidthSetting } from './types';

export const WIDTH_OPTIONS: number[] = [1024, 2048, 4096, 8192, 16384];
const AUTO_CANDIDATES: number[] = [256, 512, 1024, 2048, 4096, 8192, 16384];

export class TextureCapacityError extends Error {}

/**
 * Linear sample addressing:
 *
 *   linearSample = globalFrame * vertexCount + vertexIndex
 *   textureX     = linearSample % width
 *   textureY     = floor(linearSample / width)
 *
 * Frames are NOT row-aligned. A row may contain the tail of one frame and the
 * head of the next; the address math does not care.
 */
export function computeLayout(
  vertexCount: number,
  totalFrames: number,
  widthSetting: WidthSetting,
  maxDimension: number,
): TextureLayout {
  const usedSamples = vertexCount * totalFrames;
  if (usedSamples <= 0) throw new TextureCapacityError('Nothing to bake: 0 samples.');

  let width: number;
  if (widthSetting === 'auto') {
    const viable = AUTO_CANDIDATES.filter(
      (w) => w <= maxDimension && Math.ceil(usedSamples / w) <= maxDimension,
    );
    if (viable.length === 0) {
      throw new TextureCapacityError(
        `Cannot fit ${usedSamples.toLocaleString()} samples: no power-of-two width ` +
          `keeps height within the ${maxDimension} texel device limit. ` +
          `Reduce bake FPS, frame count, or vertex count.`,
      );
    }
    // The narrowest width that is still at least as wide as it is tall. Padding
    // can never exceed one row, and the result stays a sane GPU shape instead of
    // a 256 x 8152 sliver.
    const squarish = viable.filter((w) => Math.ceil(usedSamples / w) <= w);
    width = squarish.length > 0 ? squarish[0] : viable[viable.length - 1];
  } else {
    width = widthSetting;
    if (width > maxDimension) {
      throw new TextureCapacityError(
        `Requested width ${width} exceeds the device limit of ${maxDimension}.`,
      );
    }
  }

  const height = Math.ceil(usedSamples / width);
  if (height > maxDimension) {
    throw new TextureCapacityError(
      `Required height ${height} exceeds the device limit of ${maxDimension}. ` +
        `Try a wider texture, fewer frames, or a lower bake FPS.`,
    );
  }

  const capacity = width * height;
  return {
    width,
    height,
    usedSamples,
    capacity,
    wastedSamples: capacity - usedSamples,
    bytes: capacity * 4 * 2, // RGBA16F; use bytesPerTexture() for the real figure
  };
}

export function bytesPerTexture(layout: TextureLayout, precision: 'RGBA16F' | 'RGBA32F') {
  return layout.width * layout.height * 4 * (precision === 'RGBA16F' ? 2 : 4);
}

export function textureAddress(
  globalFrame: number,
  vertexIndex: number,
  vertexCount: number,
  width: number,
): { linear: number; x: number; y: number } {
  const linear = globalFrame * vertexCount + vertexIndex;
  return { linear, x: linear % width, y: Math.floor(linear / width) };
}

export function makeBoundsAccumulator(): Float32Array {
  return Float32Array.from([
    Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity,
  ]);
}

export function finalizeBounds(acc: Float32Array): Bounds {
  const finite = Number.isFinite(acc[0]);
  const min: [number, number, number] = finite ? [acc[0], acc[1], acc[2]] : [0, 0, 0];
  const max: [number, number, number] = finite ? [acc[3], acc[4], acc[5]] : [0, 0, 0];
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * Lookup texture: one texel per animation ID.
 *   R = StartFrame, G = FrameCount, B = FPS, A = Flags (bit0 = loop)
 * Values are raw, unnormalized floats — the texture is written as RGBA32F.
 */
export function buildLookupTexture(
  ranges: { startFrame: number; frameCount: number; fps: number; loop: boolean }[],
): { data: Float32Array; width: number; height: number } {
  const width = Math.max(1, ranges.length);
  const data = new Float32Array(width * 4);
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    data[i * 4 + 0] = r.startFrame;
    data[i * 4 + 1] = r.frameCount;
    data[i * 4 + 2] = r.fps;
    data[i * 4 + 3] = r.loop ? 1 : 0;
  }
  return { data, width, height: 1 };
}

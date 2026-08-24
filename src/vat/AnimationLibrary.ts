import type { AnimationRange, VATAnimation } from './types';

/**
 * Global frame indexing rules.
 *
 * Frames are ZERO-BASED and endFrame is INCLUSIVE, therefore
 *   frameCount = endFrame - startFrame + 1
 *
 * A looping clip omits the duplicate end frame (frame N == frame 0), a one-shot
 * clip keeps it, so:
 *   loop      -> round(duration * fps)
 *   one-shot  -> round(duration * fps) + 1
 */
export function computeFrameCount(duration: number, fps: number, loop: boolean): number {
  const steps = Math.round(duration * fps);
  return loop ? Math.max(1, steps) : Math.max(1, steps + 1);
}

/** Exact evaluation time for a local frame. Never runs past the clip. */
export function frameTime(localFrame: number, fps: number, duration: number): number {
  return Math.min(localFrame / fps, duration);
}

/** Make names unique in place; `Idle`, `Idle_1`, `Idle_2`. */
export function enforceUniqueNames(animations: VATAnimation[]): void {
  const seen = new Map<string, number>();
  for (const a of animations) {
    const base = a.name || 'Animation';
    const count = seen.get(base.toLowerCase()) ?? 0;
    seen.set(base.toLowerCase(), count + 1);
    a.name = count === 0 ? base : `${base}_${count}`;
  }
}

/**
 * Single source of truth for IDs and frame ranges. Call after ANY mutation of
 * the list: add, remove, reorder, rename, loop toggle, FPS change.
 */
export function reindex(animations: VATAnimation[], bakeFPS: number): number {
  let cursor = 0;
  for (let i = 0; i < animations.length; i++) {
    const a = animations[i];
    a.id = i;
    a.fps = bakeFPS;
    a.duration = a.clip.duration;
    a.frameCount = computeFrameCount(a.duration, bakeFPS, a.loop);
    a.startFrame = cursor;
    a.endFrame = cursor + a.frameCount - 1;
    cursor += a.frameCount;
  }
  return cursor;
}

export function totalFrames(animations: VATAnimation[]): number {
  return animations.reduce((sum, a) => sum + a.frameCount, 0);
}

export function toRanges(animations: VATAnimation[]): AnimationRange[] {
  return animations.map((a) => ({
    index: a.id,
    name: a.name,
    startFrame: a.startFrame,
    endFrame: a.endFrame,
    frameCount: a.frameCount,
    fps: a.fps,
    duration: a.duration,
    loop: a.loop,
    sourceFilename: a.sourceFilename,
  }));
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, item);
  return next;
}

/** Which animation owns a global frame, and the local frame within it. */
export function resolveGlobalFrame(
  animations: VATAnimation[],
  globalFrame: number,
): { animation: VATAnimation; localFrame: number } | null {
  for (const a of animations) {
    if (globalFrame >= a.startFrame && globalFrame <= a.endFrame) {
      return { animation: a, localFrame: globalFrame - a.startFrame };
    }
  }
  return null;
}

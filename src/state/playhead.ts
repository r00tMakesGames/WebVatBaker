import { Store } from './store';

/**
 * High-frequency playback readout, kept out of the main app store so a 60 Hz
 * scrubber does not re-render the whole tool.
 */
export interface PlayheadState {
  animationId: number;
  animationName: string;
  localFrame: number;
  localFrameCount: number;
  globalFrame: number;
  totalFrames: number;
  textureX: number;
  textureY: number;
  time: number;
}

export const playheadStore = new Store<PlayheadState>({
  animationId: -1,
  animationName: '—',
  localFrame: 0,
  localFrameCount: 0,
  globalFrame: 0,
  totalFrames: 0,
  textureX: 0,
  textureY: 0,
  time: 0,
});

import * as THREE from 'three';
import type { BoneRest } from './FBXImporter';

/**
 * Deterministic clip evaluation.
 *
 * Realtime delta stepping is never used. Every sample:
 *   1. restores every bone to its authored rest TRS, so bones the clip does not
 *      touch cannot inherit state from the previous frame or the previous clip
 *   2. writes the absolute action time
 *   3. runs the mixer with a zero delta, which makes AnimationAction evaluate
 *      its interpolants at exactly that time
 *   4. refreshes world matrices
 *
 * Step 3 is equivalent to `mixer.setTime(t)` but immune to the paused/finished
 * state a LoopOnce action enters once it passes its duration.
 */
export class AnimationSampler {
  readonly mixer: THREE.AnimationMixer;
  private action: THREE.AnimationAction | null = null;
  private currentClip: THREE.AnimationClip | null = null;

  constructor(
    private readonly root: THREE.Object3D,
    private readonly bones: THREE.Bone[],
    private readonly rest: BoneRest[],
  ) {
    this.mixer = new THREE.AnimationMixer(root);
  }

  setClip(clip: THREE.AnimationClip | null): void {
    if (clip === this.currentClip) return;
    if (this.action) {
      this.action.stop();
      this.mixer.uncacheAction(this.action.getClip(), this.root);
    }
    this.currentClip = clip;
    this.action = null;
    if (!clip) {
      this.restPose();
      return;
    }
    const action = this.mixer.clipAction(clip, this.root);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.enabled = true;
    action.weight = 1;
    action.timeScale = 1;
    action.play();
    this.action = action;
  }

  /** Restore every bone to the authored rest pose and refresh world matrices. */
  restPose(): void {
    this.restoreLocals();
    this.root.updateMatrixWorld(true);
  }

  private restoreLocals(): void {
    for (let i = 0; i < this.bones.length; i++) {
      const b = this.bones[i];
      const r = this.rest[i];
      b.position.copy(r.position);
      b.quaternion.copy(r.quaternion);
      b.scale.copy(r.scale);
    }
  }

  /** Evaluate the current clip at an absolute time in seconds. */
  sample(time: number): void {
    this.restoreLocals();
    const action = this.action;
    if (action) {
      const duration = action.getClip().duration;
      action.enabled = true;
      action.paused = false;
      action.weight = 1;
      action.time = Math.max(0, Math.min(time, duration));
      this.mixer.update(0);
    }
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    if (this.currentClip) this.mixer.uncacheClip(this.currentClip);
    this.mixer.uncacheRoot(this.root);
  }
}

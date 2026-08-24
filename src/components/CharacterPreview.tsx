import { useEffect, useRef } from 'react';
import { viewport } from '../viewport/Viewport';
import { appStore, scrubTo, setPlaying, setPreviewMode, setRestPose, setShowSkeleton, selectedAnimation } from '../state/session';
import { useStore } from '../state/store';
import { playheadStore } from '../state/playhead';
import { layoutStore, toggleFocus } from '../state/layout';

function Readout() {
  const p = useStore(playheadStore);
  const state = useStore(appStore);
  const debug = state.result !== null;

  return (
    <div className="readout">
      <span><b>Anim ID</b>{p.animationId < 0 ? '—' : p.animationId}</span>
      <span><b>Local</b>{p.localFrame.toFixed(1)} / {Math.max(0, p.localFrameCount - 1)}</span>
      <span><b>Global</b>{p.globalFrame.toFixed(1)} / {Math.max(0, p.totalFrames - 1)}</span>
      {debug && <span><b>Texel</b>{p.textureX}, {p.textureY}</span>}
      <span><b>Time</b>{p.time.toFixed(3)}s</span>
    </div>
  );
}

function Scrubber() {
  const p = useStore(playheadStore);
  const max = Math.max(0, p.localFrameCount - 1);
  return (
    <input
      className="scrubber"
      type="range"
      min={0}
      max={max}
      step={1}
      value={Math.min(Math.round(p.localFrame), max)}
      disabled={max === 0}
      onChange={(e) => scrubTo(Number(e.target.value))}
      aria-label="Timeline"
    />
  );
}

export function CharacterPreview() {
  const host = useRef<HTMLDivElement>(null);
  const state = useStore(appStore);
  const anim = selectedAnimation(state);
  const focus = useStore(layoutStore).focus;

  useEffect(() => {
    if (host.current) viewport.mount(host.current);
    return () => viewport.unmount();
  }, []);

  const hasVAT = state.result !== null;

  return (
    <section className="panel panel-preview">
      <header className="panel-head">
        <h2>3D preview</h2>
        <div className="seg">
          <button
            className={state.previewMode === 'skeletal' ? 'is-on' : ''}
            onClick={() => setPreviewMode('skeletal')}
          >
            Skeletal
          </button>
          <button
            className={state.previewMode === 'vat' ? 'is-on' : ''}
            disabled={!hasVAT}
            onClick={() => setPreviewMode('vat')}
          >
            VAT
          </button>
          <button
            className={state.previewMode === 'both' ? 'is-on' : ''}
            disabled={!hasVAT}
            onClick={() => setPreviewMode('both')}
            title="Skeletal solid with the VAT result drawn as a wireframe cage on top"
          >
            Overlay
          </button>
        </div>
        <button
          className={`btn btn-icon${focus ? ' is-on' : ''}`}
          onClick={toggleFocus}
          title={focus ? 'Restore the panel layout (Esc)' : 'Fill the window with the preview'}
        >
          {focus ? 'Exit' : 'Focus'}
        </button>
      </header>

      <div className="viewport" ref={host} />

      <div className="transport">
        <button className="btn btn-icon" onClick={() => setPlaying(!state.playing)}>
          {state.playing ? 'Pause' : 'Play'}
        </button>
        <Scrubber />
        <label className="inline">
          Speed
          <input
            type="number"
            min={0.05}
            max={4}
            step={0.05}
            value={state.playbackSpeed}
            onChange={(e) => appStore.set({ playbackSpeed: Number(e.target.value) || 1 })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.restPose}
            onChange={(e) => setRestPose(e.target.checked)}
          />
          Rest pose
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.showSkeleton}
            onChange={(e) => setShowSkeleton(e.target.checked)}
          />
          Bones
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={state.interpolate}
            onChange={(e) => appStore.set({ interpolate: e.target.checked })}
            title="Blend between the two nearest VAT frames instead of snapping"
          />
          Interpolate
        </label>
      </div>

      <Readout />
      {anim === null && !state.restPose && (
        <p className="note">Select an animation to preview it, or tick Rest pose.</p>
      )}
    </section>
  );
}

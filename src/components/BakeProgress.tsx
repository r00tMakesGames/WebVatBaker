import { useStore } from '../state/store';
import { appStore, cancelBake, runBake } from '../state/session';
import { formatBytes } from '../vat/Baker';

export function BakeProgress() {
  const state = useStore(appStore);
  const p = state.progress;
  const result = state.result;
  const ready = state.baseLoaded && state.animations.length > 0 && !state.baking;

  return (
    <section className="panel panel-status">
      <header className="panel-head">
        <h2>Bake status</h2>
        {state.baking ? (
          <button className="btn btn-danger" onClick={cancelBake}>Cancel</button>
        ) : (
          <button className="btn btn-primary" disabled={!ready} onClick={() => void runBake()}>
            Bake VAT
          </button>
        )}
      </header>

      {state.baking && p && (
        <div className="progress-block">
          <div className="progress-line mono">
            Animation {Math.min(p.animationIndex + 1, p.animationCount)} / {p.animationCount}
            {' · '}
            {p.animationName}
          </div>
          <div className="progress-line mono">
            Frame {p.frame} / {p.frameCount} · global {p.globalFrame} / {p.totalFrames}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${p.percent.toFixed(1)}%` }} />
          </div>
          <div className="progress-line mono">{p.percent.toFixed(0)}%</div>
        </div>
      )}

      {!state.baking && result && (
        <dl className="kv">
          <dt>Texture</dt>
          <dd className="mono">{result.layout.width} x {result.layout.height} {result.settings.precision}</dd>
          <dt>Samples</dt>
          <dd className="mono">{result.layout.usedSamples.toLocaleString()}</dd>
          <dt>Frames</dt>
          <dd className="mono">{result.totalFrames}</dd>
          <dt>Bounds min</dt>
          <dd className="mono">{result.bounds.min.map((v) => v.toFixed(2)).join(', ')}</dd>
          <dt>Bounds max</dt>
          <dd className="mono">{result.bounds.max.map((v) => v.toFixed(2)).join(', ')}</dd>
          <dt>Size</dt>
          <dd className="mono">{result.bounds.size.map((v) => v.toFixed(2)).join(', ')}</dd>
          <dt>Stored range</dt>
          <dd className="mono">
            {result.storedBounds.min.map((v) => v.toFixed(2)).join(', ')} →{' '}
            {result.storedBounds.max.map((v) => v.toFixed(2)).join(', ')}
          </dd>
          <dt>Bake time</dt>
          <dd className="mono">{(result.durationMs / 1000).toFixed(2)} s</dd>
          <dt>Buffers</dt>
          <dd className="mono">
            {formatBytes(result.positions.byteLength + (result.normals?.byteLength ?? 0))}
          </dd>
        </dl>
      )}

      {!state.baking && !result && (
        <p className="note">
          Nothing baked yet. Load a character, add animations, then bake to unlock the VAT preview
          and the exports.
        </p>
      )}
    </section>
  );
}

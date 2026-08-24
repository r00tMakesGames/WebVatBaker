import { useStore } from '../state/store';
import {
  appStore,
  exportAll,
  exportCSV,
  exportJSON,
  exportLookupEXR,
  exportMesh,
  exportBoneRotationEXR,
  exportNormalEXR,
  exportPositionEXR,
  exportReport,
  getOutputNames,
} from '../state/session';

function Issues() {
  const state = useStore(appStore);
  if (state.reports.length === 0) return null;
  return (
    <div className="issues">
      {state.reports.map((r) => (
        <div key={r.stage}>
          <div className="issues-head">
            <span>{r.stage}</span>
            <span className={`chip chip-${r.ok ? 'ok' : 'error'}`}>{r.ok ? 'pass' : 'fail'}</span>
          </div>
          <ul>
            {r.issues.map((i, n) => (
              <li key={n} className={`issue issue-${i.level}`}>
                <code>{i.code}</code> {i.message}
              </li>
            ))}
            {r.issues.length === 0 && <li className="issue issue-info">No issues.</li>}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Log() {
  const state = useStore(appStore);
  const recent = state.log.slice(-40).reverse();
  if (recent.length === 0) return null;
  return (
    <details className="group">
      <summary>Log ({state.log.length})</summary>
      <ul className="log">
        {recent.map((e, i) => (
          <li key={i} className={`issue issue-${e.level}`}>{e.message}</li>
        ))}
      </ul>
    </details>
  );
}

export function OutputPanel() {
  const state = useStore(appStore);
  const result = state.result;
  const names = getOutputNames();
  const ready = result !== null;

  return (
    <section className="panel panel-output">
      <header className="panel-head">
        <h2>Output &amp; validation</h2>
        <button className="btn btn-primary" disabled={!ready} onClick={() => void exportAll()}>
          Export all
        </button>
      </header>

      <ul className="outputs">
        <li>
          <button className="btn" disabled={!ready} onClick={exportPositionEXR}>EXR</button>
          <span className="mono ellipsis">
            {result?.bone ? names.bonePosition : names.position}
          </span>
        </li>
        {result?.bone ? (
          <li>
            <button className="btn" disabled={!ready} onClick={exportBoneRotationEXR}>EXR</button>
            <span className="mono ellipsis">{names.boneRotation}</span>
          </li>
        ) : (
          <li>
            <button className="btn" disabled={!ready || !result?.normals} onClick={exportNormalEXR}>EXR</button>
            <span className="mono ellipsis">{names.normal}</span>
          </li>
        )}
        <li>
          <button className="btn" disabled={!ready || !result?.lookupTexture} onClick={exportLookupEXR}>EXR</button>
          <span className="mono ellipsis">{names.lookup}</span>
        </li>
        <li>
          <button className="btn" disabled={!ready} onClick={() => void exportMesh()}>GLB</button>
          <span className="mono ellipsis">{names.mesh}</span>
        </li>
        <li>
          <button className="btn" disabled={!ready} onClick={exportJSON}>JSON</button>
          <span className="mono ellipsis">{names.json}</span>
        </li>
        <li>
          <button className="btn" disabled={!ready} onClick={exportCSV}>CSV</button>
          <span className="mono ellipsis">{names.csv}</span>
        </li>
        <li>
          <button className="btn" disabled={state.reports.length === 0} onClick={exportReport}>TXT</button>
          <span className="mono ellipsis">{names.report}</span>
        </li>
      </ul>

      <Issues />
      <Log />
    </section>
  );
}

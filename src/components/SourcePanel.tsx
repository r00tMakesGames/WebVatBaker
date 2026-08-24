import { useStore } from '../state/store';
import { appStore, loadAnimationFiles, loadBaseFile } from '../state/session';
import { DropZone } from './DropZone';
import { AnimationInspector } from './AnimationInspector';

export function SourcePanel() {
  const state = useStore(appStore);
  const summary = state.baseSummary;
  const anim = state.selectedUid
    ? (state.animations.find((a) => a.uid === state.selectedUid) ?? null)
    : null;

  return (
    <section className="panel panel-source">
      <header className="panel-head">
        <h2>Source</h2>
        {state.busy && <span className="busy mono">{state.busy}</span>}
      </header>

      <DropZone
        label={state.baseLoaded ? 'Replace base character' : 'Base character FBX'}
        hint="skinned mesh · skeleton · skin weights · bind pose"
        onFiles={(files) => void loadBaseFile(files[0])}
      />

      {summary && (
        <dl className="kv">
          <dt>File</dt>
          <dd className="mono ellipsis" title={state.baseName}>{state.baseName}</dd>
          <dt>Vertices</dt>
          <dd className="mono">{summary.vertexCount.toLocaleString()}</dd>
          <dt>Triangles</dt>
          <dd className="mono">{summary.triangleCount.toLocaleString()}</dd>
          <dt>Bones</dt>
          <dd className="mono">{summary.boneCount}</dd>
          <dt>UV sets</dt>
          <dd className="mono">{summary.uvSets.join(', ') || 'none'}</dd>
          <dt>Bounds</dt>
          <dd className="mono">{summary.bounds}</dd>
        </dl>
      )}

      <DropZone
        label="Animation FBX files"
        hint="same skeleton · names are normalized automatically"
        multiple
        disabled={!state.baseLoaded}
        onFiles={(files) => void loadAnimationFiles(files)}
      />

      <h3 className="sub">Inspector</h3>
      <AnimationInspector animation={anim} />
    </section>
  );
}

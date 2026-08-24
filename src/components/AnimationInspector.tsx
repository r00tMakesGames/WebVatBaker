import { useStore } from '../state/store';
import { appStore } from '../state/session';
import type { VATAnimation } from '../vat/types';

function BoneList({ title, bones }: { title: string; bones: string[] }) {
  if (bones.length === 0) return null;
  return (
    <details className="bones">
      <summary>
        {title} <span className="mono">{bones.length}</span>
      </summary>
      <div className="bone-scroll mono">{bones.join('\n')}</div>
    </details>
  );
}

export function AnimationInspector({ animation }: { animation: VATAnimation | null }) {
  const state = useStore(appStore);
  if (!animation) {
    return <p className="note">No clip selected.</p>;
  }
  const a = animation;
  return (
    <div className="inspector">
      <dl className="kv">
        <dt>Source</dt>
        <dd className="mono ellipsis" title={a.sourceFilename}>{a.sourceFilename}</dd>
        <dt>Duration</dt>
        <dd className="mono">{a.duration.toFixed(4)} s</dd>
        <dt>Source FPS</dt>
        <dd className="mono">{a.sourceFPS ?? 'unknown'}</dd>
        <dt>Frames @ {state.settings.bakeFPS}</dt>
        <dd className="mono">{a.frameCount}</dd>
        <dt>Global range</dt>
        <dd className="mono">{a.startFrame} – {a.endFrame}</dd>
        <dt>Bones matched</dt>
        <dd className="mono">{a.matchedBones}</dd>
        <dt>Compatibility</dt>
        <dd className={`chip chip-${a.compatibility}`}>{a.compatibility}</dd>
      </dl>
      <p className={`note note-${a.compatibility === 'ok' ? 'info' : a.compatibility}`}>
        {a.compatibilityNote}
      </p>
      <BoneList title="Missing bones (hold rest pose)" bones={a.missingBones} />
      <BoneList title="Extra bones (no target)" bones={a.extraBones} />
    </div>
  );
}

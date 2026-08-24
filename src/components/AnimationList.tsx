import { useState } from 'react';
import { useStore } from '../state/store';
import {
  appStore,
  clearAnimations,
  removeAnimation,
  renameAnimation,
  reorderAnimation,
  selectAnimation,
  toggleLoop,
} from '../state/session';
import type { VATAnimation } from '../vat/types';

const STATUS_LABEL: Record<VATAnimation['compatibility'], string> = {
  ok: 'ok',
  warning: 'partial',
  error: 'blocked',
};

/**
 * The atlas ruler: every clip drawn as its true proportional span of the global
 * frame range. It is the one place the whole bake layout is visible at once.
 */
function AtlasRuler({ animations, total, selectedUid }: {
  animations: VATAnimation[];
  total: number;
  selectedUid: string | null;
}) {
  if (total === 0) return null;
  return (
    <div className="ruler" title={`${total} global frames`}>
      {animations.map((a) => (
        <button
          key={a.uid}
          className={`ruler-seg${a.uid === selectedUid ? ' is-sel' : ''} status-${a.compatibility}`}
          style={{ flexGrow: a.frameCount }}
          onClick={() => selectAnimation(a.uid)}
          title={`${a.id} ${a.name} — frames ${a.startFrame}–${a.endFrame}`}
        >
          <span>{a.id}</span>
        </button>
      ))}
    </div>
  );
}

export function AnimationList() {
  const state = useStore(appStore);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const { animations, totalFrames, selectedUid } = state;

  return (
    <section className="panel panel-table">
      <header className="panel-head">
        <h2>Animation table</h2>
        <div className="head-meta">
          <span>{animations.length} clips</span>
          <span>{totalFrames} frames</span>
          {animations.length > 0 && (
            <button className="btn btn-quiet" onClick={clearAnimations}>
              Remove all
            </button>
          )}
        </div>
      </header>

      <AtlasRuler animations={animations} total={totalFrames} selectedUid={selectedUid} />

      <div className="table-scroll">
        <table className="anim-table">
          <thead>
            <tr>
              <th className="col-grip" />
              <th className="num">ID</th>
              <th>Name</th>
              <th className="num">Duration</th>
              <th className="num">Frames</th>
              <th className="num">Start</th>
              <th className="num">End</th>
              <th>Loop</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {animations.map((a, i) => (
              <tr
                key={a.uid}
                className={
                  (a.uid === selectedUid ? 'is-sel ' : '') +
                  (overIndex === i ? 'is-over ' : '') +
                  `status-${a.compatibility}`
                }
                draggable
                onDragStart={(e) => {
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIndex(i);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIndex !== null && dragIndex !== i) reorderAnimation(dragIndex, i);
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                onClick={() => selectAnimation(a.uid)}
              >
                <td className="col-grip" aria-hidden>⠿</td>
                <td className="num mono">{a.id}</td>
                <td className="col-name">
                  {editing === a.uid ? (
                    <input
                      autoFocus
                      defaultValue={a.name}
                      onBlur={(e) => {
                        renameAnimation(a.uid, e.target.value);
                        setEditing(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <span
                      onDoubleClick={() => setEditing(a.uid)}
                      title={`${a.sourceFilename} — double-click to rename`}
                    >
                      {a.name}
                    </span>
                  )}
                </td>
                <td className="num mono">{a.duration.toFixed(3)}s</td>
                <td className="num mono">{a.frameCount}</td>
                <td className="num mono">{a.startFrame}</td>
                <td className="num mono">{a.endFrame}</td>
                <td>
                  <input
                    type="checkbox"
                    checked={a.loop}
                    onChange={() => toggleLoop(a.uid)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Loop ${a.name}`}
                  />
                </td>
                <td>
                  <span className={`chip chip-${a.compatibility}`}>
                    {STATUS_LABEL[a.compatibility]}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-quiet"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeAnimation(a.uid);
                    }}
                    aria-label={`Delete ${a.name}`}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
            {animations.length === 0 && (
              <tr className="empty">
                <td colSpan={10}>
                  Drop animation FBX files to fill the atlas. Row order sets the animation ID.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

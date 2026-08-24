import { useEffect, useRef } from 'react';
import { SourcePanel } from './components/SourcePanel';
import { CharacterPreview } from './components/CharacterPreview';
import { BakeSettings } from './components/BakeSettings';
import { AnimationList } from './components/AnimationList';
import { OutputPanel } from './components/OutputPanel';
import { BakeProgress } from './components/BakeProgress';
import { ColumnSplitter, RowSplitter } from './components/Splitters';
import { useStore } from './state/store';
import { appStore } from './state/session';
import { layoutStore, setFocus } from './state/layout';

function TitleBar() {
  const state = useStore(appStore);
  return (
    <header className="titlebar">
      <div className="brand">
        <span className="brand-mark">VAT</span>
        <span className="brand-name">Baker</span>
      </div>
      <div className="titlebar-meta mono">
        <span>{state.settings.assetName}</span>
        <span>{state.animations.length} clips</span>
        <span>{state.totalFrames} frames</span>
        <span>{state.settings.bakeFPS} fps</span>
        <span>{state.settings.vatMode}</span>
        <span>{state.settings.precision}</span>
      </div>
    </header>
  );
}

export default function App() {
  const gridRef = useRef<HTMLElement | null>(null);
  const layout = useStore(layoutStore);

  // Escape leaves focus mode. Without it the only way out is the button, which
  // is easy to lose track of once every other panel is hidden.
  useEffect(() => {
    if (!layout.focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocus(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [layout.focus]);

  const style = {
    '--col-left': `${layout.leftWidth}px`,
    '--row-1': `${layout.rows[0]}fr`,
    '--row-2': `${layout.rows[1]}fr`,
    '--row-3': `${layout.rows[2]}fr`,
    '--rows': layout.rows.join(','),
  } as React.CSSProperties;

  return (
    <div className="app">
      <TitleBar />
      <main
        ref={gridRef}
        className={`grid${layout.focus ? ' is-focus' : ''}`}
        style={style}
      >
        <SourcePanel />
        <CharacterPreview />
        <BakeSettings />
        <AnimationList />
        <OutputPanel />
        <BakeProgress />
        {!layout.focus && (
          <>
            <ColumnSplitter gridRef={gridRef} />
            <RowSplitter index={0} gridRef={gridRef} />
            <RowSplitter index={1} gridRef={gridRef} />
          </>
        )}
      </main>
    </div>
  );
}

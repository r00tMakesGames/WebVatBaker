import { useCallback, useRef } from 'react';
import {
  MAX_LEFT,
  MIN_LEFT,
  resetLayout,
  setLeftWidth,
  setRowBoundary,
} from '../state/layout';

/**
 * Splitters are 1px grid tracks with a fat invisible hit area on top, which is
 * the only way to get a hairline divider that is still comfortable to grab.
 *
 * Pointer capture rather than window listeners: the drag keeps receiving events
 * even when the pointer crosses the WebGL canvas, which otherwise swallows them
 * for OrbitControls.
 */

function useDrag(onMove: (e: PointerEvent) => void) {
  const active = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      active.current = true;
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.classList.add('is-resizing');

      const move = (ev: PointerEvent) => {
        if (active.current) onMove(ev);
      };
      const up = (ev: PointerEvent) => {
        active.current = false;
        try {
          el.releasePointerCapture(ev.pointerId);
        } catch {
          /* pointer already gone */
        }
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        document.body.classList.remove('is-resizing');
      };

      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    },
    [onMove],
  );

  return onPointerDown;
}

export function ColumnSplitter({ gridRef }: { gridRef: React.RefObject<HTMLElement | null> }) {
  const onMove = useCallback(
    (e: PointerEvent) => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect) return;
      setLeftWidth(e.clientX - rect.left);
    },
    [gridRef],
  );

  const onPointerDown = useDrag(onMove);

  return (
    <div
      className="splitter splitter-col"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panels"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={resetLayout}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setLeftWidth(clampFromDom(gridRef, -16));
        if (e.key === 'ArrowRight') setLeftWidth(clampFromDom(gridRef, 16));
      }}
      tabIndex={0}
    />
  );
}

function clampFromDom(gridRef: React.RefObject<HTMLElement | null>, delta: number): number {
  const current = gridRef.current
    ? parseFloat(getComputedStyle(gridRef.current).getPropertyValue('--col-left')) || MIN_LEFT
    : MIN_LEFT;
  return Math.min(MAX_LEFT, Math.max(MIN_LEFT, current + delta));
}

export function RowSplitter({
  index,
  gridRef,
}: {
  index: 0 | 1;
  gridRef: React.RefObject<HTMLElement | null>;
}) {
  const onMove = useCallback(
    (e: PointerEvent) => {
      const rect = gridRef.current?.getBoundingClientRect();
      if (!rect || rect.height === 0) return;
      // Fraction of the whole grid from the top down to this boundary, minus the
      // rows above the pair being resized.
      const total = (e.clientY - rect.top) / rect.height;
      if (index === 0) {
        setRowBoundary(0, total);
      } else {
        const rows = getRows(gridRef);
        setRowBoundary(1, total - rows[0]);
      }
    },
    [gridRef, index],
  );

  const onPointerDown = useDrag(onMove);

  return (
    <div
      className={`splitter splitter-row splitter-row-${index}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize panel height"
      title="Drag to resize · double-click to reset"
      onPointerDown={onPointerDown}
      onDoubleClick={resetLayout}
      tabIndex={0}
    />
  );
}

function getRows(gridRef: React.RefObject<HTMLElement | null>): number[] {
  const raw = gridRef.current
    ? getComputedStyle(gridRef.current).getPropertyValue('--rows')
    : '';
  const parts = raw.split(',').map(Number);
  return parts.length === 3 && parts.every(Number.isFinite) ? parts : [0.383, 0.333, 0.284];
}

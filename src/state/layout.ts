import { Store } from './store';

/**
 * Panel geometry. Kept out of the main app store so that dragging a splitter at
 * pointer rate cannot re-render anything that reads bake state.
 *
 * Row sizes are fractions of the grid height rather than pixels so the layout
 * survives a window resize; the left column is a pixel width because its useful
 * range is set by its content, not by the window.
 */
export interface LayoutState {
  /** left column width, px */
  leftWidth: number;
  /** row fractions, always three, always summing to 1 */
  rows: [number, number, number];
  /** preview fills the whole work area */
  focus: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  leftWidth: 360,
  rows: [1.15 / 3, 1 / 3, 0.85 / 3],
  focus: false,
};

export const MIN_LEFT = 260;
export const MAX_LEFT = 720;
/** a row may never be squeezed below this fraction of the grid */
export const MIN_ROW = 0.08;

const KEY = 'vat-baker.layout.v1';

function load(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    const parsed = JSON.parse(raw) as Partial<LayoutState>;
    const rows = Array.isArray(parsed.rows) && parsed.rows.length === 3
      ? (parsed.rows.map(Number) as [number, number, number])
      : [...DEFAULT_LAYOUT.rows] as [number, number, number];
    const sum = rows[0] + rows[1] + rows[2];
    const safe: [number, number, number] =
      Number.isFinite(sum) && sum > 0
        ? [rows[0] / sum, rows[1] / sum, rows[2] / sum]
        : [...DEFAULT_LAYOUT.rows] as [number, number, number];
    return {
      leftWidth: clamp(Number(parsed.leftWidth) || DEFAULT_LAYOUT.leftWidth, MIN_LEFT, MAX_LEFT),
      rows: safe,
      // Focus is deliberately not restored: reopening the app into a view with
      // every other panel hidden reads as a broken layout, not a saved one.
      focus: false,
    };
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export const layoutStore = new Store<LayoutState>(load());

let saveTimer: number | null = null;
layoutStore.subscribe(() => {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(layoutStore.get()));
    } catch {
      /* private browsing, quota, and so on — layout is not worth an error */
    }
  }, 250);
});

export function setLeftWidth(px: number): void {
  layoutStore.set({ leftWidth: clamp(px, MIN_LEFT, MAX_LEFT) });
}

/**
 * Move the boundary below row `index` (0 or 1). The two rows either side of the
 * boundary trade space; the third is untouched, so dragging one splitter never
 * shifts the other.
 */
export function setRowBoundary(index: 0 | 1, fraction: number): void {
  const rows = [...layoutStore.get().rows] as [number, number, number];
  const pair = rows[index] + rows[index + 1];
  const next = clamp(fraction, MIN_ROW, pair - MIN_ROW);
  rows[index] = next;
  rows[index + 1] = pair - next;
  layoutStore.set({ rows });
}

export function resetLayout(): void {
  layoutStore.set({ ...DEFAULT_LAYOUT, focus: layoutStore.get().focus });
}

export function toggleFocus(): void {
  layoutStore.set({ focus: !layoutStore.get().focus });
}

export function setFocus(focus: boolean): void {
  layoutStore.set({ focus });
}

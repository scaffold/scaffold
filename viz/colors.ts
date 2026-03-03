/** Node names and their associated colors. */
export const NODE_NAMES = ['antelope', 'badger', 'crane', 'dolphin', 'eagle'] as const;

/** Single-letter identifiers for knowledge labels. */
export const NODE_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

export const NODE_COLORS = [
  '#e06c75', // antelope - red
  '#e5c07b', // badger - gold
  '#56b6c2', // crane - cyan
  '#61afef', // dolphin - blue
  '#c678dd', // eagle - purple
] as const;

/** Get node color by index. */
export function nodeColor(idx: number): string {
  return NODE_COLORS[idx % NODE_COLORS.length];
}

/** Short label for a block hash. */
export function hashLabel(hex: string, isGenesis: boolean): string {
  return isGenesis ? 'G' : hex.slice(0, 4);
}

/** Background color for the page. */
export const BG = '#1a1a2e';

/** Slightly lighter background for panels. */
export const PANEL_BG = '#16213e';

/** Text color. */
export const TEXT = '#e0e0e0';

/** Muted text. */
export const MUTED = '#666680';

/** Grid/line color. */
export const GRID = '#2a2a4a';

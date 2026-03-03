import { HashPrimitive } from '../src/util/Hash.ts';
import { SimEngine } from './SimEngine.ts';
import { NODE_LETTERS, nodeColor } from './colors.ts';

// Graphviz instance loaded from CDN, set by main.ts
type GraphvizInstance = { layout(dot: string, format: string, engine: string): string };

/**
 * Build the knowledge label for a block across all nodes.
 * Uppercase = node knows it and considers it canonical.
 * Lowercase = node knows it but non-canonical.
 * Omitted = node doesn't know the block.
 */
function knowledgeLabel(key: HashPrimitive, engine: SimEngine): string {
  const info = engine.blockInfos.get(key);
  if (!info) return '';
  let label = '';
  for (let i = 0; i < engine.nodes.length; i++) {
    const node = engine.nodes[i];
    if (!node.store.has(info.block.hash)) continue;
    const letter = NODE_LETTERS[i];
    if (node.consensus.isCanonical(info.block.hash)) {
      label += letter; // uppercase = canonical
    } else {
      label += letter.toLowerCase(); // lowercase = known, not canonical
    }
  }
  return label;
}

/** Escape a string for use inside graphviz double-quoted labels. */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class DagRenderer {
  private readonly container: HTMLDivElement;
  private graphviz: GraphvizInstance | null = null;
  private cachedSvg = '';
  private lastBlockCount = -1;
  private lastTickRendered = -1;

  constructor(container: HTMLDivElement) {
    this.container = container;
  }

  setGraphviz(gv: GraphvizInstance): void {
    this.graphviz = gv;
  }

  render(engine: SimEngine): void {
    if (!this.graphviz) {
      this.container.innerHTML = '<div style="color:#666;padding:20px">Loading graphviz...</div>';
      return;
    }

    // Only re-layout when something changed
    const blockCount = engine.blockInfos.size;
    if (blockCount === this.lastBlockCount && engine.tick === this.lastTickRendered) {
      return; // nothing new
    }
    this.lastBlockCount = blockCount;
    this.lastTickRendered = engine.tick;

    const dot = this.buildDot(engine);
    try {
      let svg = this.graphviz.layout(dot, 'svg', 'dot');
      // Strip fixed width/height so it fills the container
      svg = svg.replace(/<svg\s[^>]*>/, (match) => {
        return match
          .replace(/width="[^"]*"/, 'width="100%"')
          .replace(/height="[^"]*"/, 'height="100%"');
      });
      this.cachedSvg = svg;
    } catch (_e) {
      // graphviz layout can fail on malformed dot; keep cached
    }

    this.container.innerHTML = this.cachedSvg;
  }

  private buildDot(engine: SimEngine): string {
    const lines: string[] = [];
    lines.push('digraph G {');
    lines.push('  rankdir=LR;');
    lines.push('  bgcolor="transparent";');
    lines.push('  node [shape=box, style="rounded,filled", fontname="monospace", fontsize=10];');
    lines.push('  edge [color="#555577"];');

    // Assign stable short IDs
    const idMap = new Map<HashPrimitive, string>();
    let nextId = 0;
    for (const key of engine.blockInfos.keys()) {
      idMap.set(key, `n${nextId++}`);
    }

    // Nodes
    for (const [key, info] of engine.blockInfos) {
      const id = idMap.get(key)!;
      const isGenesis = info.block.anchor === undefined;
      const hashStr = isGenesis ? 'G' : key.slice(0, 4);
      const kLabel = knowledgeLabel(key, engine);
      const displayLabel = kLabel ? `${hashStr}\\n${kLabel}` : hashStr;

      const color = info.creator >= 0 ? nodeColor(info.creator) : '#888888';
      const fontColor = '#000000';

      lines.push(
        `  ${id} [label="${esc(displayLabel)}", fillcolor="${color}", fontcolor="${fontColor}"];`,
      );
    }

    // Edges: anchor (solid) and aggregate (dashed)
    for (const [key, info] of engine.blockInfos) {
      const toId = idMap.get(key)!;

      if (info.block.anchor) {
        const fromKey = info.block.anchor.toPrimitive();
        const fromId = idMap.get(fromKey);
        if (fromId) {
          lines.push(`  ${fromId} -> ${toId};`);
        }
      }

      for (const agg of info.block.aggregates) {
        const aggKey = agg.toPrimitive();
        const aggId = idMap.get(aggKey);
        if (aggId) {
          lines.push(`  ${aggId} -> ${toId} [style=dashed, color="#7777aa", constraint=false];`);
        }
      }
    }

    lines.push('}');
    return lines.join('\n');
  }
}

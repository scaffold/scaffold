import Context from './Context.ts';
import { Graphviz } from '../dev_deps.ts';
import { BlockFact, Fact } from './FactMeta.ts';
import FactService from './FactService.ts';
import { mapPut } from './util/map.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import BlockService from './BlockService.ts';
import { BlockInput } from './messages.ts';

interface Graph {
  ids: Map<unknown, string>;
  nextId: number;
  lines: string[];
}

export default class RenderService {
  private graphviz: ReturnType<typeof Graphviz['load']>;

  constructor(private ctx: Context) {
    this.graphviz = Graphviz.load();
  }

  public async renderSvg() {
    const graph: Graph = { ids: new Map(), nextId: 1, lines: [] };

    graph.lines.push(`digraph G {`);
    graph.lines.push(`rankdir=LR;`);
    // graph.lines.push(`size="8,5"`);
    graph.lines.push(`node [shape=box]`);

    for (const block of this.ctx.get(FactService).hackyGetBlocksMatching()) {
      this.renderBlock(graph, block);
    }

    graph.lines.push(`}`);

    const graphviz = await this.graphviz;
    // Formats: "svg" | "dot" | "json" | "dot_json" | "xdot_json" | "plain" | "plain-ext"
    // Engines: "circo" | "dot" | "fdp" | "sfdp" | "neato" | "osage" | "patchwork" | "twopi" | "nop" | "nop2"
    return graphviz.layout(graph.lines.join('\n'), 'svg', 'dot');
  }

  private renderBlock(graph: Graph, block: BlockFact) {
    const bId = this.getId(graph, block);
    const attrs = this.renderAttrs({
      label: block.hash.toHex().slice(0, 8),
      // color: 'black',
    });

    graph.lines.push(`  ${bId} ${attrs};`);

    this.renderFrontierVote(graph, block);
    for (const input of block.inputs) {
      this.renderInput(graph, block, input);
    }
  }

  private renderFrontierVote(graph: Graph, block: BlockFact) {
    if (block.frontierVoteBlock === ZERO_BLOCK) {
      return;
    }

    const bId = this.getId(graph, block);
    const vId = this.getId(graph, block.frontierVoteBlock);
    const attrs = this.renderAttrs({
      color: 'green',
    });

    graph.lines.push(`  ${bId} -> ${vId} ${attrs};`);
  }

  private renderInput(graph: Graph, block: BlockFact, input: BlockInput) {
    const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
    const isFrontier = inputBlock?.frontierOutputIdx === input.outputIdx;

    const bId = this.getId(graph, block);
    const iId = this.getId(graph, inputBlock);
    const attrs = this.renderAttrs({
      color: isFrontier ? 'blue' : 'black',
    });

    graph.lines.push(`  ${bId} -> ${iId} ${attrs};`);
  }

  private getId(graph: Graph, object: Fact | undefined) {
    if (object !== undefined) {
      return mapPut(graph.ids, object, () => `v${graph.nextId++}`);
    } else {
      const id = `u${graph.nextId++}`;
      graph.lines.push(`	${id} [shape=plain, label="?"];`);
      return id;
    }
  }

  private renderAttrs(attrs: { [key: string]: string }) {
    return `[${
      Object.entries(attrs).map(([key, val]) => `${key}="${val}"`).join(', ')
    }]`;
  }
}

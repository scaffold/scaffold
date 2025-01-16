import { Context } from './Context.ts';
import { Graphviz } from 'https://esm.sh/@hpcc-js/wasm@2.15.3?target=esnext&pin=v135';
import { BlockFact, Fact } from './FactMeta.ts';
import { FactService } from './FactService.ts';
import { mapPut } from './util/map.ts';
import { ZERO_BLOCK } from './BlockMeta.ts';
import { BlockService } from './BlockService.ts';
import { BlockInput, Squash } from './messages.ts';
import { WeightService } from './WeightService.ts';
import { FactType } from './FactMeta.ts';

export type RenderConfig = Partial<{
  renderFrontierVote: boolean;
  renderFrontierInputs: boolean;
  renderOtherInputs: boolean;
  renderPrimaryDescendant: boolean;
}>;

interface Graph {
  ids: Map<unknown, string>;
  nextId: number;
  lines: string[];
}

const wrapAccessor = <T>(fn: () => T) => {
  try {
    return fn();
  } catch (err) {
    console.error(err);
    return '?';
  }
};

export class RenderService {
  private graphviz: ReturnType<typeof Graphviz['load']>;

  private extra: BlockFact[] = [];

  constructor(private ctx: Context) {
    this.graphviz = Graphviz.load();
  }

  public forget(block: BlockFact) {
    this.extra.push(block);
  }

  public async renderSvg(config: RenderConfig = {}) {
    const graph: Graph = { ids: new Map(), nextId: 1, lines: [] };

    graph.lines.push(`digraph G {`);
    graph.lines.push(`  rankdir=RL;`);
    graph.lines.push(`  graph [size="1,1"];`);
    graph.lines.push(`  node [shape=box];`);

    for (const block of this.ctx.get(FactService).hackyGetBlocksMatching()) {
      this.renderBlock(graph, block, false, config);
    }

    for (const block of this.extra) {
      this.renderBlock(graph, block, true, config);
    }

    graph.lines.push(`}`);

    const graphviz = await this.graphviz;
    // Formats: "svg" | "dot" | "json" | "dot_json" | "xdot_json" | "plain" | "plain-ext"
    // Engines: "circo" | "dot" | "fdp" | "sfdp" | "neato" | "osage" | "patchwork" | "twopi" | "nop" | "nop2"
    let svg = graphviz.layout(graph.lines.join('\n'), 'svg', 'dot');
    svg = svg.replace(/^.*<svg width="[^"]+" height="[^"]+"/im, '<svg');
    return svg;
  }

  private renderBlock(
    graph: Graph,
    block: BlockFact,
    isDeleted: boolean,
    config: RenderConfig,
  ) {
    // const name = block.hash.toHex().slice(0, 8);
    const name = block.sillyName;

    const title = name + ' ^' + block.volume + ' @' + block.visitedAt;

    let props = 'DELETED';
    if (!isDeleted) {
      const work = wrapAccessor(() => {
        const selfWeight = this.ctx.get(WeightService).getSelfWeight(block);
        return selfWeight.min !== selfWeight.max
          ? `${selfWeight.min}-${selfWeight.max}`
          : selfWeight.min;
      });
      const offset = wrapAccessor(() => {
        const selfOffset = this.ctx.get(WeightService).getSelfOffset(block);
        return selfOffset.min !== selfOffset.max
          ? `${selfOffset.min}-${selfOffset.max}`
          : selfOffset.min;
      });
      const anc = wrapAccessor(() => this.ctx.get(WeightService).getAncestorWeight(block));
      const desc = wrapAccessor(() => this.ctx.get(WeightService).getDescendant(block).weight);
      const tree = block.treeWeights.join(',');
      // const vw = this.ctx.get(WeightService).getVoterWeight(block).join(',');
      const vw = `?`;
      const canon = wrapAccessor(() =>
        this.ctx.get(WeightService).getCanonicality(block).canonicality
      );
      props = [
        `work: ${work}; offset: ${offset}`,
        `anc: ${anc}; desc: ${desc}`,
        `tree: ${tree}; vw: ${vw}`,
        `canon: ${canon}`,
      ].join('\n');
    }

    const bId = this.getId(graph, block);
    const attrs = this.renderAttrs({
      label: `${title}\n${props}`,
      color: isDeleted ? 'red' : 'black',
    });

    graph.lines.push(`  ${bId} ${attrs};`);

    this.renderFrontierVote(graph, block, config);
    for (const squash of block.squashes) {
      this.renderInput(graph, block, squash, config, false);
    }
    for (const input of block.inputs) {
      this.renderInput(graph, block, input, config, false);
    }
    this.renderDescendant(graph, block, config);
  }

  private renderFrontierVote(
    graph: Graph,
    block: BlockFact,
    config: RenderConfig,
  ) {
    if (config.renderFrontierVote === false) return;

    const bId = this.getId(graph, block);
    const vId = this.getId(graph, block.parentBlock);
    const attrs = this.renderAttrs({
      color: 'green',
    });

    graph.lines.push(`  ${bId} -> ${vId} ${attrs};`);
  }

  private renderInput(
    graph: Graph,
    block: BlockFact,
    input: BlockInput | Squash,
    config: RenderConfig,
    isSquash: boolean,
  ) {
    const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);

    if (isSquash ? config.renderFrontierInputs === false : config.renderOtherInputs === false) {
      return;
    }

    const bId = this.getId(graph, block);
    const iId = this.getId(graph, inputBlock);
    const attrs = this.renderAttrs({
      color: isSquash ? 'blue' : 'gray',
      label: 'outputIdx' in input ? `$${inputBlock?.outputs[input.outputIdx].amount ?? '?'}` : '',
    });

    graph.lines.push(`  ${bId} -> ${iId} ${attrs};`);
  }

  private renderDescendant(
    graph: Graph,
    block: BlockFact,
    config: RenderConfig,
  ) {
    if (config.renderPrimaryDescendant === false) return;

    const desc = wrapAccessor(() => this.ctx.get(WeightService).getDescendant(block));
    if (desc === '?') {
      return;
    }

    const bId = this.getId(graph, block);
    const attrs = this.renderAttrs({
      color: 'red',
      constraint: 'false',
    });

    if (desc.parent !== undefined) {
      const dId = this.getId(graph, desc.parent);
      graph.lines.push(`  ${bId} -> ${dId} ${attrs};`);
    }
    for (const voter of desc.voters) {
      const dId = this.getId(graph, voter);
      graph.lines.push(`  ${bId} -> ${dId} ${attrs};`);
    }
  }

  private getId(graph: Graph, object: Fact | typeof ZERO_BLOCK | undefined) {
    if (object === undefined) {
      const id = `u${graph.nextId++}`;
      graph.lines.push(`	${id} [shape=plain, label="?"];`);
      return id;
    } else if (object === ZERO_BLOCK) {
      return mapPut(graph.ids, object, () => `ZERO`);
    } else {
      return mapPut(graph.ids, object, () => `v${graph.nextId++}`);
    }
  }

  private renderAttrs(attrs: { [key: string]: string }) {
    return `[${Object.entries(attrs).map(([key, val]) => `${key}="${val}"`).join(', ')}]`;
  }
}

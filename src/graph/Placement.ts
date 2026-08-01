import { Context } from '../Context.ts';
import { Forest } from './Forest.ts';
import {
  PlacementBase,
  PlacementRequest as PlacementRequestTmpl,
  PlacementResult as PlacementResultTmpl,
} from '../logic/Placement.ts';
import { Block, BlockRef } from './types.ts';

export type PlacementNode = Block | BlockRef;
export type PlacementRequest = PlacementRequestTmpl<PlacementNode>;
export type PlacementResult = PlacementResultTmpl<PlacementNode>;

export class Placement extends PlacementBase<PlacementNode> {
  constructor(private ctx: Context) {
    super();
  }

  protected override anchorChain(node: PlacementNode) {
    return this.ctx.get(Forest).anchorChain<Block>(node);
  }

  protected override aggregators(node: PlacementNode) {
    return this.ctx.get(Forest).aggregators(node);
  }
}

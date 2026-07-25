import { Context } from '../Context.ts';
import { BROKEN_ANCHOR_CHAIN, ForestService } from './ForestService.ts';
import {
  PlacementModule,
  PlacementRequest as PlacementRequestTmpl,
  PlacementResult as PlacementResultTmpl,
} from './PlacementModule2.ts';
import { Block, BlockRef } from './types.ts';

export type PlacementNode = Block | BlockRef;
export type PlacementRequest = PlacementRequestTmpl<PlacementNode>;
export type PlacementResult = PlacementResultTmpl<PlacementNode>;

export class PlacementService extends PlacementModule<PlacementNode> {
  constructor(private ctx: Context) {
    super();
  }

  protected override anchorChain(node: PlacementNode) {
    return this.ctx.get(ForestService).anchorChain(node);
  }

  protected override aggregators(node: PlacementNode) {
    return this.ctx.get(ForestService).aggregators(node);
  }
}

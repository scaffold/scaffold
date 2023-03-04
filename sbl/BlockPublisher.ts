import Context from './Context.ts';
import { Block } from './messages.ts';
import NodeService from './NodeService.ts';

export default class BlockPublisher {
  constructor(private ctx: Context) {}

  public publish(block: Block) {
    this.ctx.get(NodeService).getAll().forEach((node) => {
      if (!node.knownBlocks.has(block)) {
        node.knownBlocks.add(block);
        node.defaultConn?.sendReliable({ PublicationMessage: { block } });
      }
    });
  }
}

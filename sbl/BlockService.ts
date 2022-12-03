import BlockIngestor from './BlockIngestor.ts';
import BlockPublisher from './BlockPublisher.ts';
import Context from './Context.ts';
import { Block } from './messages.ts';

export default class BlockService {
  constructor(private ctx: Context) {}

  public async ingest(block: Block) {
    console.log('Ingesting block...', block);

    try {
      await this.ctx.get(BlockIngestor).ingest(block);
    } catch (err) {
      console.error('Error ingesting block', block, ':', err);
      return;
    }

    console.log('Publishing block...', block);

    this.ctx.get(BlockPublisher).publish(block);
  }
}

import Context from './Context.ts';
import GraphUtils from './GraphUtils.ts';
import { Block } from './messages.ts';
import Hash from './util/Hash.ts';
import Store from './util/Store.ts';

export class BlockStore extends Store<Block> {
  constructor(private ctx: Context) {
    super();
  }
}

export class GeneratorStore extends Store<Uint8Array> {
  constructor(private ctx: Context) {
    super(
      ctx.get(BlockStore).map((_hash, block, emit) => {
        if (
          Hash.equals(
            block.verifier.contract_hash,
            ctx.get(GraphUtils).getGeneratorContract(),
          )
        ) {
          emit(Hash.fromBytes(block.verifier.params), block.body);
        }
      }),
    );
  }
}

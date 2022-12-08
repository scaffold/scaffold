import Context from './Context.ts';
import GraphUtils from './GraphUtils.ts';
import { Block, Claim, Verifier } from './messages.ts';
import Hash from './util/Hash.ts';
import Store from './util/Store.ts';

// Key is block hash
export class BlockStore extends Store<Block> {
  constructor(private ctx: Context) {
    super();
  }
}

// Key is contract hash that generator fulfills
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

// Key is verifier hash
export class FulfillmentStore extends Store<Claim> {
  constructor(private ctx: Context) {
    super(
      ctx.get(BlockStore).map((hash, block, emit) => {
        block.incentives.forEach((incentive) => {
          const verifier_hash = Hash.digest(
            Verifier.encode(incentive.verifier),
          );
          const claim = { block_hash: hash, amount: incentive.amount };
          emit(verifier_hash, claim);
        });
      }),
    );
  }
}

// Every property is one on a subnet or potential block?
//   Also block CROSS generator(s)
//   Maybe this is the primitive - incentives automatically spawn potential generations, which are considered independently

// Each output/license/incentive has an "ownership" probability.
// For my account, it's 1.0.
// For others' accounts, it's 0.0.
// For remote questions I'm not going to answer, it's ~0.000001
// For questions I'm going to attempt to answer, it's ~0.1
// For the epoch it's ~0.001

/*
Pick a block to compute. This is based on:
  Predict expected timestamp (on the block)


Sample evenly from block distriubtion:
  Each peer sends summaries (BlockSets) of what it sees
  Ask for X% from each peer

Pick a block to validate.



Pay to an answer to question X
  TARGET.verifier == X
  [{verifier: X}]
Pay to any answer signed by X
  TARGET.author == X
  [{author: X}]
Pay to (y = answer to question X with author Y; claim to question Z of answer y)
  y.verifier == X
  y.claims[i].verifier == Z
  TARGET = y.claims[i]
  [{verifier: X, author: Y}, {verifier: Z}]
  Worker peer responds with a block that NEEDS (negative incentive) inclusion in:
    [{verifier: X, author: Y}]
  This is complicated and kind of an exchange that only benefits 2 parties, so I don't think we need it.
*/

/*
interface BlockSubnetMeta {
  isIoZeroSum?: boolean;
}


generator block + current incentive (may be removed or fulfilled) -> add to work queue
incentive added -> increase work queue priority

generator block -> verifier hash
non-generator block -> null


With a subset of blocks we have -




    const verifier_hash = Hash.digest(Verifier.encode(block.verifier));
    this.ctx.get(FulfillmentRegistry).getOrCreate(
      verifier_hash,
      () => [block],
      (arr) => {
        arr.push(block);
        return arr;
      },
    );

    const block_hash = this.hashBlock(block);
    if (!this.ingesting.has(block_hash.toHex())) {
      this.ingesting.add(block_hash.toHex());

      this.checkZeroSum(block);
      await Promise.all([
        this.checkBlockTimestamp(block),
        this.checkBlockMergability(block),
      ]);

    }

    return block_hash;

    */

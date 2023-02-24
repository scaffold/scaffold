import { BlockExt, BlockMeta } from './BlockMeta.ts';
import Context from './Context.ts';
import GraphUtils from './GraphUtils.ts';
import { Block, BlockOutput, Verifier } from './messages.ts';
import { arrConcat } from './util/buffer.ts';
import Hash from './util/Hash.ts';
import Store from './util/Store.ts';
import {
  amountAccumulator,
  arrayAccumulator,
  bigintAccumulator,
} from './accumulators.ts';

// SELECT * FROM blocks;
export class BlockStore extends Store<BlockExt> {
  constructor(private ctx: Context) {
    super();
  }

  public static hash(block: Block) {
    return Hash.digest(Block.encode(block));
  }
}

// SELECT inputs FROM blocks WHERE generating;
export class RequestsByGenerationStore
  extends Store<{ incentive: bigint; requests: Verifier[] }> {
  constructor(private ctx: Context) {
    super();
  }

  // Should 1-1 correspond with an execution of WorkQueue.callWithSyncRequestHandler
  public static hash(verifier: Verifier, generator: Uint8Array) {
    // TODO: This is kinda hacky
    return Hash.digestParts(
      Verifier.encode(verifier),
      generator.byteLength,
      generator,
    );
  }

  public update(generationHash: Hash, incentive: bigint, requests: Verifier[]) {
    this.mutate(generationHash, (prev) => {
      // TODO: Don't update down-stream when not much changes

      if (prev) {
        const x = prev.incentive / BigInt(prev.requests.length);
        prev.requests.forEach((req) =>
          this.ctx.get(ExtraIncentiveByVerifierStore).mutate(
            Hash.digest(Verifier.encode(req)),
            (prev) => ({ verifier: req, amount: prev!.amount - x }),
          )
        );
      }

      if (requests.length) {
        const x = incentive / BigInt(requests.length);
        requests.forEach((req) =>
          this.ctx.get(ExtraIncentiveByVerifierStore).mutate(
            Hash.digest(Verifier.encode(req)),
            (prev) => ({ verifier: req, amount: prev ? prev.amount + x : x }),
          )
        );

        return { incentive, requests };
      } else {
        return undefined;
      }
    });
  }
}

// SELECT inputs FROM blocks WHERE generating;
export class ExtraIncentiveByVerifierStore extends Store<BlockOutput> {
  constructor(private ctx: Context) {
    super(
      ctx.get(RequestsByGenerationStore).groupBy<BlockOutput>(
        (_hash, { incentive, requests }, emit) =>
          requests.forEach((req) =>
            emit(Hash.digest(Verifier.encode(req)), {
              verifier: req,
              amount: incentive / BigInt(requests.length),
            })
          ),
        ...amountAccumulator,
      ),
    );
  }
}

export class GeneratorsByContractStore extends Store<BlockExt[]> {
  constructor(private ctx: Context) {
    super(
      ctx.get(BlockStore).groupBy<BlockExt, BlockExt[]>(
        (_hash, block, emit) =>
          // TODO: Match multiple contracts as generators - one for each type (wasm, js, oracle, human...)
          Hash.equals(
            block.verifier.contract_hash,
            ctx.get(GraphUtils).getGeneratorContract(),
          ) &&
          emit(Hash.fromBytes(block.verifier.params), block),
        ...arrayAccumulator,
      ),
    );
  }
}

export class IncentivesByBlockHashAndVerifierStore extends Store<BlockOutput> {
  constructor(private ctx: Context) {
    super(
      // Hashes will never collide here
      Store.outerJoin(
        ctx.get(BlockStore).groupBy<BlockOutput>(
          (hash, block, emit) =>
            block.outputs.forEach(({ verifier, amount }) =>
              emit(
                Hash.digestParts(hash, Verifier.encode(verifier)),
                { verifier, amount },
              )
            ),
          ...amountAccumulator,
        ),
        ctx.get(ExtraIncentiveByVerifierStore),
        (_hash, x, y) => x || y,
      ),
    );
  }
}

export class ClaimsByBlockHashAndVerifierStore extends Store<bigint> {
  constructor(private ctx: Context) {
    super(
      ctx.get(BlockStore).groupBy<bigint>(
        (_hash, block, emit) =>
          block.inputs.forEach(({ block_hash, amount }) =>
            emit(
              Hash.digestParts(block_hash, Verifier.encode(block.verifier)),
              amount,
            )
          ),
        ...bigintAccumulator,
      ),
    );
  }
}

export class UnclaimedIncentivesByBlockHashAndVerifierStore
  extends Store<BlockOutput> {
  constructor(private ctx: Context) {
    super(Store.leftJoin(
      ctx.get(IncentivesByBlockHashAndVerifierStore),
      ctx.get(ClaimsByBlockHashAndVerifierStore),
      (_hash, incentive, claims) =>
        claims !== undefined
          ? {
            verifier: incentive.verifier,
            amount: incentive.amount - claims,
          }
          : incentive,
    ));
  }
}

export class UnclaimedIncentivesByContractStore extends Store<BlockOutput[]> {
  constructor(private ctx: Context) {
    super(
      ctx.get(UnclaimedIncentivesByBlockHashAndVerifierStore)
        .groupBy<BlockOutput, BlockOutput[]>(
          (_hash, incentive, emit) =>
            incentive.amount < 0n &&
            emit(incentive.verifier.contract_hash, incentive),
          ...arrayAccumulator,
        ),
    );
  }
}

export class BlocksByVerifierStore extends Store<BlockExt[]> {
  constructor(private ctx: Context) {
    super(
      ctx.get(BlockStore).groupBy<BlockExt, BlockExt[]>(
        (_hash, block, emit) =>
          emit(Hash.digest(Verifier.encode(block.verifier)), block),
        ...arrayAccumulator,
      ),
    );
  }
}

// Things we can work on that have generators
export class WorkableIncentivesStore extends Store<
  { generator: BlockExt; verifier: Verifier; amount: bigint }
> {
  constructor(private ctx: Context) {
    super(
      Store.innerJoin(
        ctx.get(GeneratorsByContractStore),
        ctx.get(UnclaimedIncentivesByContractStore),
        (_hash, generators, incentives) => ({ generators, incentives }),
      ).groupBy<{ generator: BlockExt; verifier: Verifier; amount: bigint }>(
        (_hash, { generators, incentives }, emit) =>
          incentives.forEach(({ verifier, amount }) =>
            generators.forEach((generator) =>
              emit(
                Hash.digestParts(
                  generator.verifier.contract_hash, // Small set of generator contracts
                  generator.body,
                  Verifier.encode(verifier),
                ),
                { generator, verifier, amount },
              )
            )
          ),
        ...amountAccumulator,
      ),
    );
  }
}

// Things we can work on, regardless of whether we have generators or not
export class LaunchableIncentivesStore
  extends Store<{ verifier: Verifier; amount: bigint }> {
  constructor(private ctx: Context) {
    super(
      ctx.get(UnclaimedIncentivesByContractStore)
        .groupBy<{ verifier: Verifier; amount: bigint }>(
          (_hash, incentives, emit) =>
            incentives.forEach(({ verifier, amount }) =>
              emit(Hash.digest(Verifier.encode(verifier)), { verifier, amount })
            ),
          ...amountAccumulator,
        ),
    );
  }
}

// score = 0
//   + published incentive
//   - published claims

// score += 0
//   + Multiplicative cumulative probability of invalidity of existing blocks
//     * unpublished incentive

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

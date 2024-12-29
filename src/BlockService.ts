import { BlockFlag, BlockMeta, OutputClaim, ZERO_BLOCK } from './BlockMeta.ts';
import {
  accountHash,
  collateralHash,
  dataHash,
  epochHash,
  epochInclusionHash,
  frontierHash,
  rootHash,
  timeHash,
} from './constants.ts';
import { Context } from './Context.ts';
import { VerificationService } from './VerificationService.ts';
import { Logger } from './Logger.ts';
import {
  Block,
  BlockInput,
  BlockOutput,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
import { PeerManager } from './PeerManager.ts';
import { QaDebugger } from './QaDebugger.ts';
import { arrEquals } from './util/buffer.ts';
import { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { BlockFact, Collateralization, Fact, FactBase, FactSource, FactType } from './FactMeta.ts';
import { FactService, headerSize } from './FactService.ts';
import { ContractClassifierService } from './ContractClassifierService.ts';
import { assert, neverPromise, todo } from './util/functional.ts';
import { LitigationService } from './LitigationService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
  CollateralHint,
} from './collateralMessages.ts';
import { FrontierService2, NUM_FRONTIER_LEVELS } from './FrontierService2.ts';
import { ResolvingMonitor, WatchingMonitor } from './util/Monitor.ts';
import { MaybePromise, maybeThen } from './util/MaybePromise.ts';
import { CollateralUtil, CONTEST_TYPE_FINAL } from './CollateralUtil.ts';
import { WeightService } from './WeightService.ts';
import { MonitoringService } from './MonitoringService.ts';
import { UnspentOutputManager } from './UnspentOutputManager.ts';
import { neverAbort } from './util/abortable.ts';
import { GenerationService } from './GenerationService.ts';
import { raceTruthy } from './util/MaybePromise.ts';
import { BlockRecordSet } from './record_sets/BlockRecordSet.ts';
import { GenesisService } from './GenesisService.ts';
import { ClockService } from './ClockService.ts';
import { FactEmitter } from './FactEmitter.ts';
import { RenderService } from './RenderService.ts';
import { bigintMax } from './util/bigint.ts';
import { bigintMin } from './util/bigint.ts';
import { BlockMetrics } from './BlockMetrics.ts';

export const CHALLENGE_PRICE = 10n;

export const BASE_WORK = 10n;

export class BlockService {
  private claimsByOutput = new Map<HashPrimitive, OutputClaim[]>();
  private frontierVoters = new Map<HashPrimitive, BlockFact[]>();

  public blockMonitor = new ResolvingMonitor<Hash, BlockFact>((h) => h.toPrimitive()); // Key is block hash
  public satisfactionMonitor = new WatchingMonitor<
    Verifier,
    (block: BlockFact) => void
  >((v) => Hash.digest(Verifier.encode(v)).toPrimitive()); // Key is input verifier

  constructor(private ctx: Context) {}

  public hash(block: Block, signer: Hash) {
    return Hash.digestParts(signer, Block.encode(block));
  }

  public create(block: Block, mutator?: (fact: Fact) => void): BlockFact {
    // Immortalization attempts to spread the block as widely as possible to make it immutable and hard to change.

    return this.ctx
      .get(FactService)
      .emit(block, Block, FactType.Block, true, mutator);
  }

  // public compare(a: BlockFact, b: BlockFact) {
  //   // TODO: Use a frontier block

  //   if (a === b) {
  //     return 0;
  //   }

  //   const aHeight = a.highestParentChain.length;
  //   const bHeight = b.highestParentChain.length;

  //   const aWork = aHeight ? a.highestParentChain[aHeight - 1].votes : a.votes;
  //   const bWork = bHeight ? b.highestParentChain[bHeight - 1].votes : b.votes;
  //   if (aWork === undefined || bWork === undefined) {
  //     return 0;
  //   }
  //   if (aWork !== bWork) {
  //     // Unmerged chains but we can still order them by placing the higher work one first
  //     return bWork - aWork;
  //   }

  //   if (aHeight !== bHeight) {
  //     // Unmerged chains but we can still order them by placing the higher one first
  //     return bHeight - aHeight;
  //   }

  //   for (let i = 0; i < aHeight; i++) {
  //     if (a.highestParentChain[i] === b.highestParentChain[i]) {
  //       const aHash = i ? a.highestParentChain[i - 1].hash : a.hash;
  //       const bHash = i ? b.highestParentChain[i - 1].hash : b.hash;
  //       const merge = a.highestParentChain[i];
  //       if (
  //         Hash.equals(aHash, merge.left_child) &&
  //         Hash.equals(bHash, merge.right_child)
  //       ) {
  //         return -1;
  //       } else if (
  //         Hash.equals(aHash, merge.right_child) &&
  //         Hash.equals(bHash, merge.left_child)
  //       ) {
  //         return 1;
  //       } else {
  //         throw new Error(`Unexpected merge children`);
  //       }
  //     }
  //   }

  //   console.warn(`Chains aren't merged yet!`);
  //   return 0;
  // }

  public sort(items: { block: BlockFact }[], frontier: never) {
    throw new Error(`Unimplemented`);
  }

  public updateWeight(block: BlockFact) {
    let weight = this.ctx.get(WeightService).getSelfWeight(block).min;

    const parentClaims = block.outputClaims[block.frontierOutputIdx];
    // TODO: Only canonical claims

    /*
    Look at all distinct, mergeable, descendant blocks
    A block B's vote is valid if B and it's vote chain includes all inputs and refs as tree children.
    The valid descendants (outputs, referrers) of B will have either B or a tree parent of B in their vote chain.
    The descendants reached by iterating voters are unique
    Mergeability: Follow frontier votes (don't follow tree parents - if there's parents, we should be merging them instead)
      In this case, we just need to check for double-claims on the tree inputs
    Should we pull descendants from the voter(s) or a parent?
      Whatever is heaviest, potentially both. Order by weight, then use DP to find heaviest mergeable subset.

    Let's say there's 3 frontier voters of block B with the same level but various weights.
      The descendant weight of B should be the weight of the mergeable subset with maximum weight


    */

    /*
      In general, if a parent is WORSE by weight than its 2 children, don't even consider it as a valid block
        It might become valid in the future if stuff is built upon it
      */

    block.treeParent = undefined;
    if (parentClaims.length > 0) {
      // Add parent weight
      const minClaimWeight = parentClaims.map((x) =>
        this.ctx.get(WeightService).getSelfWeight(x.block).min
      ).reduce(bigintMin);

      const weights = parentClaims.map((x) =>
        x.block.descWeight -
        this.ctx.config.getOverpaymentPenalty(
          this.ctx.get(WeightService).getSelfWeight(x.block).max -
            minClaimWeight,
        )
      );
      const bestWeight = weights.reduce(bigintMax);

      weight += bestWeight;
      block.treeParent = parentClaims[weights.indexOf(bestWeight)].block;

      // Add sibling weight
    }

    // for (const voter of block.frontierVoters){
    //   if (block.treeParent!==undefined&&){}
    // }

    // TODO: Fuzzy threshold
    if (weight !== block.descWeight) {
      block.descWeight = weight;

      this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(block);

      // TODO: Add to priority queue so we update weights from the deepest to shallowest (genesis)

      if (
        block.frontierVoteBlock !== undefined &&
        block.frontierVoteBlock !== ZERO_BLOCK
      ) {
        this.updateWeight(block.frontierVoteBlock);
      }

      for (const input of block.inputs) {
        const inputBlock = this.get(input.blockHash, false);
        if (inputBlock !== undefined) {
          this.updateWeight(inputBlock);
        }
      }
    }
  }

  private checkInputAvailability(block: BlockFact) {
    let inputSum = 0n;
    let inputFreeMarketSum = BASE_WORK;
    if (
      block.inputs.every(({ blockHash, outputIdx }) => {
        const block = this.get(blockHash, false);
        if (block !== undefined) {
          const { amount, verifier } = block.outputs[outputIdx];
          inputSum += amount;
          if (this.ctx.get(ContractClassifierService).isFreeMarket(verifier)) {
            inputFreeMarketSum += amount;
          }
          return true;
        } else {
          return false;
        }
      })
    ) {
      const outputSum = block.outputs.reduce(
        (acc, { amount }) => acc + amount,
        0n,
      );
      if (
        this.ctx.config.enableValidation &&
        block.source !== FactSource.Genesis &&
        inputSum !== outputSum
      ) {
        throw new Error(
          `Input sum (${inputSum}) does not equal the output sum (${outputSum}) for block ${block.hash.toHex()}`,
        );
      }

      const outputCharitySum = block.outputs.reduce(
        (acc, { amount, verifier }) =>
          this.ctx.get(ContractClassifierService).isCharity(verifier) ? acc + amount : acc,
        0n,
      );

      // Work = MAX(0, non-free-market outputs - non-free-market inputs)
      // Work = MAX(0, free-market inputs - free-market outputs)
      block.claimedWork = inputFreeMarketSum > outputCharitySum
        ? inputFreeMarketSum - outputCharitySum
        : 0n;
      const delta = block.claimedWork - block.votes;
      // this.ctx.get(FrontierService).updateBlockVotes(block, delta);
    }
  }

  public updateCanonicalities(blocks: BlockFact[]) {
    this.ctx.get(WeightService).resetCache();
    this.ctx.get(BlockMetrics).reset();

    for (const block of blocks) {
      const newCanonicality = this.ctx.get(WeightService)
        .getCanonicality(block).canonicality;
      if (newCanonicality !== block.canonicality) {
        if (block.canonicality < 0n && newCanonicality >= 0n) {
          this.markCanonical(block);
        } else if (block.canonicality >= 0n && newCanonicality < 0n) {
          this.markUncanonical(block);
        }
        block.canonicality = newCanonicality;
        this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(block);
      }
    }

    this.ctx.get(FactEmitter).updateFrontier();
  }

  private markCanonical(block: BlockFact) {
    block.inputs.forEach((input, idx) => {
      const parent = this.get(input.blockHash, false);
      if (parent) {
        this.ctx.get(UnspentOutputManager).remove(
          parent.outputs[input.outputIdx].verifier,
          (x) => x.block === parent && x.outputIdx === input.outputIdx,
        );
      }
    });

    block.outputs.forEach((output, outputIdx) => {
      const claims = this.getClaims({ blockHash: block.hash, outputIdx });
      if (
        claims.every((x) => !this.ctx.get(WeightService).isCanonical(x.block)) &&
        output.amount >= 0n
      ) {
        this.ctx.get(UnspentOutputManager)
          .insert(output.verifier, { block, outputIdx, amount: output.amount });
        this.ctx.get(GenerationService).ensureRunning(output.verifier);
      }
    });
  }

  private markUncanonical(block: BlockFact) {
    block.inputs.forEach((input, idx) => {
      const claims = this.getClaims(input);
      if (
        claims.every((x) => !this.ctx.get(WeightService).isCanonical(x.block))
      ) {
        const parent = this.get(input.blockHash, false);
        if (parent) {
          const output = parent.outputs[input.outputIdx];
          if (output.amount >= 0n) {
            this.ctx.get(UnspentOutputManager).insert(output.verifier, {
              block: parent,
              outputIdx: input.outputIdx,
              amount: output.amount,
            });
            this.ctx.get(GenerationService).ensureRunning(output.verifier);
          }
        }
      }

      const { usurper } = this.ctx.get(WeightService).getCanonicality(block);
      if (usurper !== undefined) {
        this.ctx.get(FactEmitter).notify(usurper.block);
      }
    });

    block.outputs.forEach((output, outputIdx) => {
      this.ctx.get(UnspentOutputManager).remove(
        output.verifier,
        (x) => x.block === block && x.outputIdx === outputIdx,
      );
    });
  }

  private setCanonicality(block: BlockFact, isCanonical: boolean) {
    if (isCanonical !== block.isCanonical) {
      block.isCanonical = isCanonical;

      for (const output of block.outputClaims) {
        for (const claim of output) {
          if (isCanonical) {
            this.setCanonicality(
              claim.block,
              this.get(claim.block.frontierVote, false)?.isCanonical !==
                  false &&
                claim.block.inputs.every(
                  (x) => this.get(x.blockHash, false)?.isCanonical !== false,
                ),
            );
          } else {
            this.setCanonicality(claim.block, false);
          }
        }
      }
    }
  }

  public linkNewAncestor(parent: BlockFact, child: BlockFact) {}

  public linkNewDescendant(parent: BlockFact, child: BlockFact) {}

  public updateCanonicality(block: BlockFact, someInputCanonicality?: boolean) {
    // Note that we consider missing inputs as canonical.
    // We also short-circuit if an input canonicality is false, which is a common case.

    const canonicality = block.inputs.reduce((acc, input) => {
      const claims = this.getClaims(input);
      const maxCompetitorWork = Math.max(
        ...claims.map((c) => c.block === block ? 0 : c.block.derivedWorkValue),
      );
      assert(maxCompetitorWork !== -Infinity);
      const delta = block.derivedWorkValue - maxCompetitorWork;
      const inputBlock = this.get(input.blockHash, false);
      const inputCanonicality = inputBlock === undefined
        ? delta
        : Math.min(delta, inputBlock.canonicalityOld);
      return Math.min(acc, inputCanonicality);
    }, Infinity);

    if (canonicality !== block.canonicalityOld) {
      block.canonicalityOld = canonicality;
      if (canonicality > 0) {
        // this.onCanonicalBlockListeners
      }
      for (const claims of block.outputClaims) {
        // const maxDerivedWork = isCanonical &&
        //   Math.max(...claims.map((c) => c.derivedWorkValue));
        for (const claim of claims) {
          this.updateCanonicality(
            claim.block,
            // claim.block.derivedWorkValue === maxDerivedWork,
          );
        }
      }
    }

    for (const { blockHash } of block.inputs) {
      const input = this.get(blockHash, false);
      if (input !== undefined) {
        this.updateCollateral(input);
      }
    }
  }

  public updateCollateral(block: BlockFact) {
    block.collateral = block.outputs.reduce(
      (acc, { amount }, idx) =>
        amount > 0n
          ? Math.max(
            acc,
            Math.min(
              Number(amount),
              block.outputClaims[idx].reduce(
                (acc, claim) => Math.max(acc, claim.block.canonicalityOld),
                0,
              ),
            ),
          )
          : acc,
      0,
    );
  }

  public updateDerivedWork(block: BlockFact) {
    let sum = Number(block.votes);

    for (const claims of block.outputClaims) {
      for (const claim of claims) {
        if (claim.block.canonicalityOld > 0) {
          sum += claim.block.derivedWorkValue /
            claim.block.inputs.filter(({ blockHash }) => this.get(blockHash, false)).length;
        }
      }
    }

    const err = Math.abs(sum - block.derivedWorkValue);
    if (err > block.derivedWorkError) {
      console.error(
        `Actual derived work error (${err}) is greater than the computed error (${block.derivedWorkError})! `,
      );
    }

    block.derivedWorkValue = sum;
    block.derivedWorkError = 0;

    const knownInputs = block.inputs
      .map(({ blockHash }) => this.get(blockHash, false))
      .filter(Boolean);
    const errInc = err / knownInputs.length;
    for (const input of knownInputs) {
      input!.derivedWorkError += errInc;
      if (input!.derivedWorkError > input!.derivedWorkValue * 0.1) {
        this.updateDerivedWork(input!);
      }
    }

    for (const claims of block.outputClaims) {
      for (const claim of claims) {
        this.updateLogMergeableProbability(claim.block);
      }
    }

    this.updateCanonicality(block);
    this.updateLogMergeableProbability(block);
  }

  public updateLogMergeableProbability(block: BlockFact) {
    // Commented out because I think a canonicality bool is fine
    /*
    let sum = 0;
    for (const { block_hash, amount } of block.inputs) {
      const inBlock = this.get(block_hash);
      if (inBlock) {
        const idx = inBlock.outputs.findIndex((o) =>
          Hash.equals(
            o.verifier.contractHash,
            block.verifier.contractHash,
          ) && arrEquals(o.verifier.params, block.verifier.params) &&
          o.amount === amount
        );
        if (idx === -1) {
          throw new Error(
            `Invalid input Block doesn't output to this verifier with amount ${amount}`,
          );
        }

        const claims = inBlock.outputClaims[idx];
        const total = claims.reduce(
          (acc, cur) => acc + cur.derivedWorkValue,
          0,
        );
        sum += Math.log(block.derivedWorkValue / total);
        sum += inBlock.mergeableLogProbabilityValue /
          inBlock.outputClaims.filter((claims) => claims.length).length;
      }
    }

    const err = Math.abs(sum - block.mergeableLogProbabilityValue);
    if (err > block.mergeableLogProbabilityError) {
      console.error(
        `Actual log mergeable probability error (${err}) is greater than the computed error (${block.mergeableLogProbabilityError})! `,
      );
    }

    block.mergeableLogProbabilityValue = sum;
    block.mergeableLogProbabilityError = 0;

    const errInc = err /
      block.outputClaims.filter((claims) => claims.length).length;
    if (block.outputClaims.length !== block.outputs.length) {
      throw new Error(`Internal error`);
    }
    for (let i = 0; i < block.outputClaims.length; i++) {
      const output = block.outputs[i];
      const claims = block.outputClaims[i];
      for (const outputBlock of claims) {
        outputBlock.mergeableLogProbabilityError += errInc;
        if (
          outputBlock.mergeableLogProbabilityError >
            outputBlock.mergeableLogProbabilityValue * 0.1
        ) {
          this.updateLogMergeableProbability(outputBlock);
        }
      }
      this.ctx.get(WorkQueue).update(output.verifier);
    }
    */
  }

  public getBlockIndex(block: BlockFact): { min: bigint; max: bigint } {
    // Walk up towards frontier; computing the unique index that this block is aiming to be included at
    if (block.frontierVoteBlock === undefined) {
      throw new Error(`Unconnected block!`);
    }

    if (block.frontierVoteBlock === ZERO_BLOCK) {
      return todo();
    }

    const treeSize = (2n << BigInt(block.frontierParams.level)) - 1n;
    const voteIdx = this.getBlockIndex(block.frontierVoteBlock);
    return {
      min: voteIdx.min + treeSize,
      max: voteIdx.max +
        (2n << BigInt(block.frontierVoteBlock.frontierParams.level)) -
        1n -
        BigInt(
          block.frontierVoteBlock.frontierParams.level -
            block.frontierParams.level,
        ),
    };
  }

  public getVoters(frontierVote: Hash) {
    return getOrCreate(
      this.frontierVoters,
      frontierVote.toPrimitive(),
      () => [],
    );
  }

  public getClaims(input: { blockHash: Hash; outputIdx: number }) {
    // TODO: I think this is secure (resistant to collisions), but should verify
    return getOrCreate(
      this.claimsByOutput,
      Hash.digestParts(input.blockHash, input.outputIdx).toPrimitive(),
      () => [],
    );
  }

  public getImplicitClaimAgainst(initialClaimFor: bigint) {
    return initialClaimFor > CHALLENGE_PRICE ? initialClaimFor - CHALLENGE_PRICE : 0n;
  }

  private getSamplesPerWork() {
    return 0.1;
  }

  private calculateMergeableProbability(block: BlockFact) {
    let prob = 1;
    for (const { blockHash, outputIdx } of block.inputs) {
      const inBlock = this.get(blockHash, false);
      if (inBlock) {
        const claims = inBlock.outputClaims[outputIdx];
        const total = claims.reduce(
          (acc, cur) => acc + cur.block.derivedWork,
          0,
        );
        prob *= block.derivedWork / total;
      }
    }
    return prob;
  }

  private calculateDerivedWork(block: BlockFact) {
    let res = 0;
    for (const output of block.outputClaims) {
      for (const claim of output) {
        res += claim.block.derivedWork * claim.block.mergeableProbability;
      }
    }
    return res;
    // return BigInt(res) - BigInt(block.receivedTimestamp);
  }

  public areVerifiersEqual(a: Verifier, b: Verifier) {
    return (
      Hash.equals(a.contractHash, b.contractHash) &&
      arrEquals(a.params, b.params)
    );
  }

  // TODO: Rename to getBlock
  public get(hash: Hash, request = true): BlockFact | undefined {
    // TODO: Instead of calling this, call into FactService
    // TODO: Incentivize network as well

    const fact = this.ctx.get(FactService).get(hash, request);
    if (fact?.type === FactType.Block) {
      return fact;
    }

    // return new Promise<Block>((resolve) => {
    //   const observer = StoreObserver.get(this.ctx.get(BlockStore));
    //   const cb = (block: Block | undefined) => {
    //     observer.unobserve(hash, cb);
    //     resolve(block!);
    //   };
    //   observer.observe(hash, cb);
    // });
  }

  public getBlocksByVerifier(verifier: Verifier) {
    return this.ctx
      .get(FactService)
      .hackyGetBlocksMatching()
      .flatMap((block) => {
        const input = block.inputs.find((input) => {
          const inputBlock = this.get(input.blockHash, false);
          return inputBlock !== undefined &&
            this.areVerifiersEqual(
              inputBlock.outputs[input.outputIdx].verifier,
              verifier,
            );
        });
        return input !== undefined ? [{ block, groupIdx: input.groupIdx }] : [];
      });
  }

  public getBlocksByInput(input: { blockHash: Hash; outputIdx: number }) {
    return this.ctx
      .get(FactService)
      .hackyGetBlocksMatching((block) =>
        block.inputs.some(
          (y) =>
            Hash.equals(y.blockHash, input.blockHash) &&
            y.outputIdx === input.outputIdx,
        )
      );
  }

  public getBlocksByOutput(verifier: Verifier) {
    return this.ctx
      .get(FactService)
      .hackyGetBlocksMatching()
      .flatMap((block) =>
        block.outputs.flatMap((y, idx) =>
          Hash.equals(y.verifier.contractHash, verifier.contractHash) &&
            arrEquals(y.verifier.params, verifier.params)
            ? [{ block, idx }]
            : []
        )
      );
  }

  public getBlocksByOutputFilter(
    contractHash: Hash,
    cond: (params: Uint8Array) => boolean,
  ) {
    return this.ctx
      .get(FactService)
      .hackyGetBlocksMatching()
      .flatMap((block) =>
        block.outputs.flatMap((y, idx) =>
          Hash.equals(y.verifier.contractHash, contractHash) &&
            cond(y.verifier.params)
            ? [{ block, idx }]
            : []
        )
      );
  }

  public waitForBlock(
    hash: Hash,
    cancelSignal: AbortSignal,
    filter?: (val: BlockFact) => boolean,
  ) {
    const got = this.get(hash);
    if (got) {
      return got;
    }
    return this.blockMonitor.waitFor(hash, cancelSignal, filter);
  }

  public async getSelfVerification(block: BlockFact) {
    const myCollateral = this.getBlocksByOutput({
      contractHash: collateralHash,
      params: CollateralContractParams.encode({ blockHash: block.hash }),
    }).filter(({ block }) => block.source === FactSource.Local); // TODO: Filter by signature so we get our blocks even if someone else sent them to us

    // myCollateral
  }

  // Note that contestations still may be in progress
  public async waitForVerification(
    block: BlockFact,
    cancelSignal = neverAbort,
  ) {
    const groupIdxs = new Set(block.inputs.map((x) => x.groupIdx));

    for (const groupIdx of groupIdxs) {
      const hint = CollateralHint.encode({
        hint: { CollateralHintVerifier: { groupIdx } },
      });

      while (
        this.ctx.get(FactService).getValidity(block.hash, [hint]) === undefined
      ) {
        if (cancelSignal.aborted) {
          return neverPromise;
        }
        await new Promise<void>((resolve) => {
          const listener = () => this.ctx.config.timeProvider.clearTimeout(hdl);
          const hdl = this.ctx.config.timeProvider.setTimeout(() => {
            cancelSignal.removeEventListener('abort', listener);
            resolve();
          }, 100);
          cancelSignal.addEventListener('abort', listener);
        });
      }
    }

    return CollateralUtil.isValid(
      CollateralUtil.buildTree(block.collateralizations),
    );
  }

  public async waitForConsumption(
    input: { blockHash: Hash; outputIdx: number },
    cancelSignal = neverAbort,
  ) {
    while (true) {
      const blocks = this.getBlocksByInput(input);
      if (blocks.length > 0) {
        if (blocks.length > 1) {
          console.warn(`Multiple blocks consuming; simply choosing first!`);
        }
        return blocks[0];
      }

      if (cancelSignal.aborted) {
        return neverPromise;
      }
      await new Promise<void>((resolve) => {
        const listener = () => this.ctx.config.timeProvider.clearTimeout(hdl);
        const hdl = this.ctx.config.timeProvider.setTimeout(() => {
          cancelSignal.removeEventListener('abort', listener);
          resolve();
        }, 100);
        cancelSignal.addEventListener('abort', listener);
      });
    }
  }

  public satisfies(
    block: BlockFact,
    groupIdx: number,
    verifier: Verifier,
    cancelSignal: AbortSignal,
  ) {
    return maybeThen(
      raceTruthy(
        (until) =>
          block.inputs.map((input) =>
            input.groupIdx === groupIdx && maybeThen(
              this.waitForBlock(input.blockHash, until),
              (block) =>
                this.areVerifiersEqual(
                  block.outputs[input.outputIdx].verifier,
                  verifier,
                ),
            )
          ),
        cancelSignal,
      ),
      (x) => x ?? false,
    );
  }

  public getGroupIndex(
    block: BlockFact,
    verifier: Verifier,
    cancelSignal: AbortSignal,
  ): MaybePromise<number | undefined> {
    if (cancelSignal.aborted) {
      return neverPromise;
    }

    // TODO: Cache unused abort controllers
    const controller = new AbortController();
    const promises: { inputPromise: Promise<BlockFact>; input: BlockInput }[] = [];
    for (const input of block.inputs) {
      const inputPromise = this.ctx
        .get(BlockService)
        .waitForBlock(input.blockHash, controller.signal);
      if (inputPromise instanceof Promise) {
        cancelSignal.addEventListener('abort', () => controller.abort());
        promises.push({ inputPromise, input });
      } else {
        const test = inputPromise.outputs[input.outputIdx].verifier;
        if (this.areVerifiersEqual(test, verifier)) {
          controller.abort();
          return input.groupIdx;
        }
      }
    }

    let remaining = promises.length;
    if (remaining === 0) {
      return;
    }

    return new Promise<number | undefined>((resolve) => {
      promises.forEach(async ({ inputPromise, input }) => {
        const test = (await inputPromise).outputs[input.outputIdx].verifier;
        if (this.areVerifiersEqual(test, verifier)) {
          controller.abort();
          resolve(input.groupIdx);
        } else {
          if (--remaining === 0) {
            resolve(undefined);
          }
        }
      });
    });
  }
}

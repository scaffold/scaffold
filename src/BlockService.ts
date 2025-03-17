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
} from './hashes.ts';
import { Context } from './Context.ts';
import {
  Block,
  BlockInput,
  BlockOutput,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
import { PeerManager } from './PeerManager.ts';
import { arrEquals } from './util/buffer.ts';
import { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { getOrCreate, mapDec, mapInc, mapPut } from './util/map.ts';
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
import { ResolvingMonitor, WatchingMonitor } from './util/Monitor.ts';
import { MaybePromise, maybeThen } from './util/MaybePromise.ts';
import { CollateralUtil, CONTEST_TYPE_FINAL } from './CollateralUtil.ts';
import { MonitoringService } from './MonitoringService.ts';
import { neverAbort } from './util/abortable.ts';
import { raceTruthy } from './util/MaybePromise.ts';
import { BlockRecordSet } from './record_sets/BlockRecordSet.ts';
import { GenesisService } from './GenesisService.ts';
import { ClockService } from './ClockService.ts';
import { FactEmitter } from './FactEmitter.ts';
import { RenderService } from './RenderService.ts';
import { bigintMax } from './util/bigint.ts';
import { bigintMin } from './util/bigint.ts';
import { BlockMetrics } from './BlockMetrics.ts';
import { FrontierService } from './FrontierService.ts';
import { assertUnique, mergeSorted } from './util/sorted.ts';
import { CanonicalityService } from './CanonicalityService.ts';
import { assertMatch } from '@std/assert/match';
import { assertEquals } from '@std/assert/equals';
import { areTreesEqual, encodeDataTree } from './DataTreeHelper.ts';
import { DataTree } from './protocol/base.ts';

export const CHALLENGE_PRICE = 10n;

export const BASE_WORK = 10n;

export class BlockService {
  private claimsByOutput = new Map<HashPrimitive, OutputClaim[]>();
  private frontierVoters = new Map<HashPrimitive, BlockFact[]>();
  private squashers = new Map<HashPrimitive, BlockFact[]>();

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

  public scatterSpends(
    block: BlockFact | typeof ZERO_BLOCK,
    utxoIdxs: number[],
    cb: (block: BlockFact, utxoIdx: number) => void,
  ) {
    if (utxoIdxs.length === 0) {
      return;
    }
    if (block === ZERO_BLOCK) {
      throw new Error(`Attempting to spend utxos from the zero block!`);
    }

    let offset = 0;
    let limit = block.outputs.length;
    let squashIdx = block.squashes.length;

    let propagateTo: BlockFact | typeof ZERO_BLOCK | undefined;
    let spentUtxoIdxs: number[] | undefined;
    let spentIdx = 0;
    let rebasedUtxoIdxs: number[] = [];

    console.log('SCATTER', block.sillyName, utxoIdxs);

    for (const idx of utxoIdxs) {
      while (idx >= limit) {
        if (propagateTo !== undefined && rebasedUtxoIdxs.length > 0) {
          this.scatterSpends(propagateTo, rebasedUtxoIdxs, cb);
          rebasedUtxoIdxs = [];
        }
        assert(rebasedUtxoIdxs.length === 0);

        if (--squashIdx >= 0) {
          const squash = block.squashes[squashIdx];
          propagateTo = this.get(squash.blockHash, false);
          spentUtxoIdxs = propagateTo !== undefined
            ? propagateTo.inputs.map((x) => x.utxoIdx)
            : undefined;

          offset = limit;
          limit += squash.newUtxoCount;
        } else {
          propagateTo = block.parentBlock;
          spentUtxoIdxs = propagateTo !== undefined && propagateTo !== ZERO_BLOCK
            ? mergeSorted(block.squashedUtxoIdxs, propagateTo.inputs.map((x) => x.utxoIdx))
            : block.squashedUtxoIdxs;
          assertUnique(spentUtxoIdxs);

          offset = limit;
          limit = Infinity;
        }

        console.log(
          'SCATTER while',
          idx,
          offset,
          limit,
          squashIdx,
          propagateTo === undefined || propagateTo === ZERO_BLOCK
            ? propagateTo
            : propagateTo.sillyName,
        );
      }

      console.log(
        'SCATTER do',
        idx,
        offset,
        limit,
        squashIdx,
        propagateTo === undefined || propagateTo === ZERO_BLOCK
          ? propagateTo
          : propagateTo.sillyName,
      );

      if (spentUtxoIdxs !== undefined) {
        while (
          spentIdx < spentUtxoIdxs.length &&
          spentUtxoIdxs[spentIdx] <= idx - offset
        ) {
          spentIdx++;
          offset--;
        }
      }

      if (propagateTo === undefined) {
        cb(block, idx - offset);
      } else {
        rebasedUtxoIdxs.push(idx - offset);
      }
    }

    console.log(
      'SCATTER end',
      propagateTo === undefined || propagateTo === ZERO_BLOCK ? propagateTo : propagateTo.sillyName,
      rebasedUtxoIdxs,
    );

    if (propagateTo !== undefined && rebasedUtxoIdxs.length > 0) {
      this.scatterSpends(propagateTo, rebasedUtxoIdxs, cb);
    }
  }

  public getRecursiveSquashers(block: BlockFact, dst = new Set<BlockFact>()): Set<BlockFact> {
    for (const squasher of block.squashers) {
      dst.add(squasher);
      this.getRecursiveSquashers(squasher, dst);
    }
    return dst;
  }

  public propagateClaims(
    block: BlockFact | typeof ZERO_BLOCK,
    utxoIdxs: number[],
    fromBlock: BlockFact,
  ) {
    const squashers = this.getRecursiveSquashers(fromBlock);

    console.log(
      'PROPAGATE',
      block === undefined || block === ZERO_BLOCK ? block : block.sillyName,
      utxoIdxs,
      fromBlock.sillyName,
    );

    this.scatterSpends(block, utxoIdxs, (dst, outputIdx) => {
      console.log(
        'PROPAGATE push',
        dst.sillyName,
        outputIdx,
        dst.claims.get(outputIdx),
        fromBlock.sillyName,
      );

      mapPut(dst.claims, outputIdx, () => [fromBlock], (claims) => {
        assert(!claims.includes(fromBlock));

        for (const claim of claims) {
          if (!squashers.has(claim) && !this.getRecursiveSquashers(claim).has(fromBlock)) {
            mapInc(claim.conflicts, fromBlock);
            mapInc(fromBlock.conflicts, claim);
          }
        }

        claims.push(fromBlock);

        return claims;
      });
    });
  }

  public removeClaims(
    block: BlockFact | typeof ZERO_BLOCK,
    utxoIdxs: number[],
    fromBlock: BlockFact,
  ) {
    this.scatterSpends(block, utxoIdxs, (block, utxoIdx) => {
      const claims = block.claims.get(utxoIdx);
      if (claims !== undefined) {
        const idx = claims.indexOf(fromBlock);
        assert(idx !== -1);

        claims[idx] = claims[claims.length - 1];
        claims.pop();

        for (const claim of claims) {
          mapDec(claim.conflicts, fromBlock);
          mapDec(fromBlock.conflicts, claim);
        }
      }
    });
  }

  public getConflictSet(block: BlockFact): Set<BlockFact> {
    if (block.parentBlock === undefined) {
      throw new Error(`Unconnected parent chain`);
    } else if (block.parentBlock === ZERO_BLOCK) {
      return new Set([...block.conflicts.keys()]);
    } else {
      return this.getConflictSet(block.parentBlock).union(block.conflicts);
    }
  }

  // TODO: Short-circuit true when all refs + inputs are canonical
  public isMergeable(refs: BlockFact[], inputs: { block: BlockFact; utxoIdxs: number[] }[]) {
    let conflicts = new Set<BlockFact>();

    for (const { block, utxoIdxs } of inputs) {
      this.scatterSpends(block, utxoIdxs, (block, utxoIdx) => {
        for (const claim of block.claims.get(utxoIdx) ?? []) {
          conflicts.add(claim);
        }
      });
    }

    for (const ref of refs) {
      if (conflicts.size > 0) {
        let ptr: BlockFact | typeof ZERO_BLOCK = ref;
        do {
          if (conflicts.has(ptr)) {
            return false;
          }

          if (ptr.parentBlock === undefined) {
            throw new Error(`Unconnected parent chain`);
          } else {
            ptr = ptr.parentBlock;
          }
        } while (ptr !== ZERO_BLOCK);
      }

      conflicts = conflicts.union(this.getConflictSet(ref));
    }

    return true;
  }

  public compareFrontierChainDepth(
    lhs: BlockFact | typeof ZERO_BLOCK,
    rhs: BlockFact | typeof ZERO_BLOCK,
  ) {
    const lhsRoot = lhs === ZERO_BLOCK ? ZERO_BLOCK : lhs.parentChainRoot;
    const rhsRoot = rhs === ZERO_BLOCK ? ZERO_BLOCK : rhs.parentChainRoot;
    if (lhsRoot !== rhsRoot) {
      throw Error(`Unconnected frontier chain!`);
    }
    const lhsDepth = lhs === ZERO_BLOCK ? 0 : lhs.parentChainDepth;
    const rhsDepth = rhs === ZERO_BLOCK ? 0 : rhs.parentChainDepth;
    return lhsDepth - rhsDepth;
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
    for (const block of blocks) {
      const isCanonical = this.ctx.get(BlockMetrics).get(block, 'isCanonical');
      if (isCanonical !== block.isCanonical) {
        block.isCanonical = isCanonical;
        if (isCanonical) {
          this.ctx.get(CanonicalityService).onCanonical(block);
        } else {
          this.ctx.get(CanonicalityService).offCanonical(block);
        }

        this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(block);
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

  // public getBlockIndex(block: BlockFact): { min: bigint; max: bigint } {
  //   // Walk up towards frontier; computing the unique index that this block is aiming to be included at
  //   if (block.parentBlock === undefined) {
  //     throw new Error(`Unconnected block!`);
  //   }

  //   if (block.parentBlock === ZERO_BLOCK) {
  //     return todo();
  //   }

  //   const treeSize = (2n << BigInt(block.frontierParams.level)) - 1n;
  //   const voteIdx = this.getBlockIndex(block.parentBlock);
  //   return {
  //     min: voteIdx.min + treeSize,
  //     max: voteIdx.max +
  //       (2n << BigInt(block.parentBlock.frontierParams.level)) -
  //       1n -
  //       BigInt(
  //         block.parentBlock.frontierParams.level -
  //           block.frontierParams.level,
  //       ),
  //   };
  // }

  public getVoters(frontierVote: Hash) {
    return getOrCreate(this.frontierVoters, frontierVote.toPrimitive(), () => []);
  }

  public getSquashers(squashed: Hash) {
    return getOrCreate(this.squashers, squashed.toPrimitive(), () => []);
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
      areTreesEqual(a.params, b.params)
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
      .flatMap((block) =>
        block.inputs.filter((input) => {
          const inputBlock = this.get(input.blockHash, false);
          return inputBlock !== undefined &&
            this.areVerifiersEqual(
              inputBlock.outputs[input.outputIdx].verifier,
              verifier,
            );
        }).map((input) => ({ block, groupIdx: input.groupIdx }))
      );
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
            areTreesEqual(y.verifier.params, verifier.params)
            ? [{ block, idx }]
            : []
        )
      );
  }

  public getBlocksByOutputFilter(
    contractHash: Hash,
    cond: (params: DataTree) => boolean,
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
      params: encodeDataTree(block.hash),
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
      const hint = encodeDataTree(CollateralHint.encode({
        hint: { CollateralHintVerifier: { groupIdx } },
      }));

      while (this.ctx.get(FactService).getValidity(block.hash, [hint]) === undefined) {
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

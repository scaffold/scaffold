import { BlockService } from '../BlockService.ts';
import { Context } from '../Context.ts';
import { BlockFact, FactBase, FactSource, FactType } from '../FactMeta.ts';
import { FactService, headerSize } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { BlockRecordSet } from '../record_sets/BlockRecordSet.ts';
import { Block, BlockOutput, FrontierTreeDetail, FrontierTreeParams } from '../messages.ts';
import { BlockFlag, BlockMeta, ZERO_BLOCK } from '../BlockMeta.ts';
import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { collateralHash, frontierHash, squashHash } from '../hashes.ts';
import { MonitoringService } from '../MonitoringService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
  CollateralHint,
} from '../collateralMessages.ts';
import { ClockService } from '../ClockService.ts';
import { RenderService } from '../RenderService.ts';
import { FactEmitter } from '../FactEmitter.ts';
import { assert } from '../util/functional.ts';
import { VOLUME_INCLUDES_SELF } from '../FrontierService3.ts';
import { FrontierService } from '../FrontierService.ts';
import { error } from '../util/functional.ts';
import { SQUASH_MIN_VOLUME_RATIO } from '../constants.ts';
import { arrEquals, EMPTY_ARR } from '../util/buffer.ts';
import { LitigationService } from '../LitigationService.ts';
import { BlockMetrics } from '../BlockMetrics.ts';
import { CanonicalityService } from '../CanonicalityService.ts';
import { QaService } from '../QaService.ts';
import { RoutingService2 } from '../RoutingService2.ts';
import { OrchestrationService } from '../OrchestrationService.ts';
import { encodeDataTree } from '../DataTreeHelper.ts';
import { ContractRecordSet } from '../record_sets/ContractRecordSet.ts';

export class BlockIngestor implements IngestionProvider<FactType.Block> {
  type = FactType.Block as const;
  isTransient = false as const;
  isPersistent = true;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase): BlockFact {
    const block = Block.decode(base.message);

    if (
      this.ctx.config.discardFutureBlocks &&
      block.timestamp > BigInt(this.ctx.config.timeProvider.now())
    ) {
      throw new Error(`Discarding block because the timestamp is too late`);
    }

    // console.log(
    //   `Ingesting block ${block.verifier.contractHash.toHex()} : ${
    //     trunc(bin2hex(block.verifier.params), 100)
    //   } -> ${trunc(bin2hex(block.body), 100)}`,
    // );
    // console.log(block);

    if (
      !this.ctx.config.enableFrontierVote &&
      !Hash.equals(block.parent, ZERO_HASH)
    ) {
      throw new Error(`Cannot ingest a block with a parent!`);
    }

    if (
      !this.ctx.config.enableBlockThroughput &&
      base.source !== FactSource.Genesis &&
      block.outputs.some((x) => x.amount !== 0n)
    ) {
      throw new Error(`Cannot ingest a block with coin throughput!`);
    }

    const parentBlock = Hash.equals(block.parent, ZERO_HASH)
      ? ZERO_BLOCK
      : this.ctx.get(BlockService).get(block.parent, false);

    const meta: BlockMeta = {
      // verifiers: block.bodies.map(() => undefined),

      childWeight: 0n,

      claims: new Map(),

      conflicts: new Map(),

      descWeight: 0n,
      canonicality: 0n,

      flags: BlockFlag.None,
      votes: 0n,
      derivedWork: 0,
      mergeableProbability: 0,

      inputOutputIdxs: block.inputs.map(() => undefined),

      outputClaims: block.outputs.map((_, idx) =>
        this.ctx.get(BlockService).getClaims({
          blockHash: base.hash,
          outputIdx: idx,
        })
      ),

      isCanonical: false,

      parentBlock,
      parentChainRoot: parentBlock === undefined
        ? base as BlockFact
        : parentBlock === ZERO_BLOCK
        ? ZERO_BLOCK
        : parentBlock.parentChainRoot,
      parentChainDepth: parentBlock === undefined
        ? 0
        : parentBlock === ZERO_BLOCK
        ? 1
        : parentBlock.parentChainDepth + 1,

      children: this.ctx.get(BlockService).getVoters(base.hash),

      propagationMask: 0,

      derivedWorkValue: 0,
      derivedWorkError: Infinity,
      mergeableLogProbabilityValue: 0,
      mergeableLogProbabilityError: 0,

      canonicalityOld: 0,
      collateral: 0,

      // ...this.getFrontierMeta(block),

      squashers: this.ctx.get(BlockService).getSquashers(base.hash),

      persistentSources: [],
    };

    return Object.assign(base, block, meta, {
      type: FactType.Block as const,
    });
  }

  ingest(fact: BlockFact) {
    const squashHashPrims = new Set(fact.squashes.map((x) => x.blockHash.toPrimitive()));
    if (squashHashPrims.size !== fact.squashes.length) {
      throw new Error(`Duplicate squash hash!`);
    }

    if (fact.treeWeights.length > 256) {
      throw new Error(`Too many tree weights!`);
    }
    for (const weight of fact.treeWeights) {
      if (weight < 0n) {
        throw new Error(`Invalid tree weight ${weight}!`);
      }
    }

    this.ctx.get(BlockService).blockMonitor.resolveAll(fact.hash, fact);

    this.ctx.get(BlockService).getVoters(fact.parent).push(fact);

    if (fact.parentBlock !== undefined && fact.parentBlock !== ZERO_BLOCK) {
      this.linkFrontier(fact.parentBlock, fact);
    }

    for (const voter of fact.children) {
      voter.parentBlock = fact;
      this.linkFrontier(fact, voter);
    }

    for (const squash of fact.squashes) {
      this.ctx.get(BlockService).getSquashers(squash.blockHash).push(fact);
    }

    if (
      !fact.inputs.some((x) => x.utxoIdx >= fact.outputs.length) &&
      fact.source !== FactSource.Genesis
    ) {
      throw new Error(`Blocks must have at least one external input!`);
    }

    fact.inputs.forEach((input, idx) => {
      if (input.outputIdx < 0) {
        throw new Error(`Invalid outputIdx ${input.outputIdx}`);
      }

      if (input.utxoIdx < 0) {
        throw new Error(`Invalid utxoIdx ${input.utxoIdx}`);
      }

      // TODO: Make this case work; just plugin an EMPTY_ARR or an undefined body
      if (input.groupIdx < 0) {
        throw new Error(`Invalid groupIdx ${input.groupIdx} on input!`);
      }

      const claims = this.ctx.get(BlockService).getClaims(input);
      const claim = { block: fact, inputIdx: idx };
      claims.push(claim);
      this.ctx.get(MonitoringService).claimMonitor.callAll(input, claim);

      const inputBlock = this.ctx.get(BlockService).get(input.blockHash, false);
      if (inputBlock) {
        this.linkIo(inputBlock, fact, input.outputIdx, idx);
      }
    });

    fact.outputs.forEach((output, outputIdx) => {
      // TODO: Make this case work; just plugin an EMPTY_ARR or an undefined body
      if (output.groupIdx < 0) {
        throw new Error(`Invalid groupIdx ${output.groupIdx} on input!`);
      }

      if (output.amount < 0n && !Hash.equals(output.verifier.contractHash, frontierHash)) {
        throw new Error(
          `Negative output amounts are only allowed on frontier outputs!`,
        );
      }

      const claims = this.ctx.get(BlockService).getClaims({
        blockHash: fact.hash,
        outputIdx,
      });
      if (claims.length) {
        claims.forEach(({ block, inputIdx }) => this.linkIo(fact, block, outputIdx, inputIdx));
      } else if (output.amount >= 0n) {
        // We set a timeout because ensureRunning gets this block recursively
        // When we move this to an ingestion method we can remove the timeout.

        // this.ctx.get(ClockService).setTimeout(() => {
        // Also need to consider the fact that this might be a stub block that's immediately going to be claimed (created in BlockBuilder)
        if (claims.length) {
          return;
        }

        // TODO: Move this to the CanonicalityService
        this.ctx.get(OrchestrationService).launchGenerator(output.verifier);
        // }, 0);
      } else {
        // TODO: What to do in this case; we still need to make the output available if it's required
        // We should add it anyways, and make sure we filter for an appropriate amount when waiting
      }

      if (Hash.equals(output.verifier.contractHash, collateralHash)) {
        const params = CollateralContractParams.decode(output.verifier.params.value!.bytes);
        const detailDec = CollateralContractDetail.decode(output.detail.value!.bytes);

        if (this.ctx.get(FactService).isSignedByMe(fact)) {
          this.ctx.get(FactService)
            .updateValidity(params.blockHash, detailDec.hints, detailDec.vote);
        }

        this.ctx.get(FactService).addCollateral(params.blockHash, {
          collateralBlock: fact,
          collateralOutputIdx: outputIdx,
          detail: detailDec,
          amount: output.amount,
        });

        // const contestedBlock = this.ctx.get(FactService).get(params.block_hash);
        // if (contestedBlock !== undefined) {
        //   if (contestedBlock.type !== FactType.Block) {
        //     throw new Error(`Cannot contest a non-block`);
        //   }
        //   this.ctx.get(LitigationService).scheduleResolution(contestedBlock);
        // }
      }

      this.ctx.get(MonitoringService).verifierOutputMonitor
        .callAll(output.verifier, fact, outputIdx);

      // if (Hash.equals(verifier.contractHash, epochInclusionHash)) {
      //   const { hash } = EpochInclusionParams.decode(verifier.params);
      //   this.ctx.get(EpochContract).addInclusionHash(fact, outputIdx, hash);
      // }
    });

    if (fact.inputs.length === 0) {
      // this.checkInputAvailability(fact);
    }

    if (fact.body.value !== null && fact.body.value.bytes.byteLength >= headerSize) {
      this.ctx.get(ClockService).setTimeout(() => {
        try {
          // TODO: Set the fromNode correctly here
          this.ctx.get(FactService).ingest(fact.body.value!.bytes, fact.source);
        } catch (err) {
          // If it fails no worries; it just wasn't a valid block
          console.debug(err);
        }
      }, 0);
    }

    // this.ctx.get(BlockSetService).getVoters(block.frontier_vote, -1).push(fact);
    // this.ctx.get(FrontierService).ingestBlock(fact);

    // this.updateDerivedWork(fact);

    // const samples = PoissonDistribution.sample(
    //   Number(this.getWork(fact)) * this.getSamplesPerWork(),
    // );
    // if (samples > 0) {
    //   this.ctx.get(DerivedWorkService).addSample(fact);
    // }

    // try {
    //   this.ctx.get(BlockStore).insert(BlockStore.hash(block), block);
    //   // await this.ctx.get(BlockIngestor).ingest(block);
    // } catch (err) {
    //   console.error(
    //     'Error ingesting block',
    //     this.ctx.get(Logger).serialize(block),
    //     ':',
    //     err,
    //   );
    //   return;
    // }

    // console.log('Publishing block...', this.ctx.get(Logger).serialize(block));

    this.ctx.maybeGet(BlockRecordSet)?.dispatchAdd(fact);
    this.ctx.maybeGet(ContractRecordSet)?.ingestBlock(fact);

    this.initSpendPropagation(fact);

    // This must come after the conflict sets are updated
    this.ctx.get(BlockMetrics).reset();
    fact.isCanonical = this.ctx.get(BlockMetrics).get(fact, 'isCanonical');
    if (fact.isCanonical) {
      this.ctx.get(CanonicalityService).onCanonical(fact);
    } else {
      this.ctx.get(CanonicalityService).offCanonical(fact);
    }
    this.ctx.get(BlockService).updateCanonicalities(
      this.ctx.get(FactService).hackyGetBlocksMatching(),
    );

    for (const block of this.ctx.get(FactService).hackyGetBlocksMatching()) {
      this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(block);
    }
  }

  forget(fact: BlockFact) {
    for (const voter of fact.children) {
      voter.parentBlock = undefined;
    }

    const voters = this.ctx.get(BlockService).getVoters(fact.parent);
    const idx = voters.indexOf(fact);
    if (idx !== -1) {
      voters.splice(idx, 1);
    }

    for (const input of fact.inputs) {
      const claims = this.ctx.get(BlockService).getClaims(input);
      const idx = claims.findIndex((claim) => claim.block === fact);
      if (idx !== -1) {
        claims.splice(idx, 1);
      }
    }

    let outputIdx = 0;
    for (const output of fact.outputs) {
      if (Hash.equals(output.verifier.contractHash, collateralHash)) {
        const params = CollateralContractParams.decode(output.verifier.params.value!.bytes);
        this.ctx.get(FactService).forgetCollateral(params.blockHash, fact);
      }

      outputIdx++;
    }

    this.ctx.maybeGet(RenderService)?.forget(fact);
    this.ctx.maybeGet(BlockRecordSet)?.dispatchRemove(fact);
  }

  private getFrontierMeta(block: Block) {
    const cb = (output: BlockOutput) => Hash.equals(output.verifier.contractHash, frontierHash);
    const idx = block.outputs.findIndex(cb);
    if (idx === -1 || block.outputs.findLastIndex(cb) !== idx) {
      throw new Error(`Not exactly one frontier output!`);
    }
    const output = block.outputs[idx];
    const frontierParams = FrontierTreeParams.decode(output.verifier.params.value!.bytes);
    const frontierDetail = FrontierTreeDetail.decode(output.detail.value!.bytes);

    // if (
    //   frontierParams.level < 0 ||
    //   frontierParams.level >= NUM_FRONTIER_LEVELS
    // ) {
    //   throw new Error(`Invalid frontier level ${frontierParams.level}!`);
    // }

    return { frontierVote: block.parent, frontierOutputIdx: idx, frontierParams, frontierDetail };
  }

  private linkFrontier(frontierVote: BlockFact, block: BlockFact) {
    if (
      this.ctx.config.graphParameters.enforceTimestampMonotonicity &&
      block.timestamp <
        frontierVote.timestamp +
          this.ctx.config.graphParameters.minimumGenerationTime
    ) {
      throw new Error(`Generation time is too short!`);
    }

    // if (frontierVote.frontierParams.level < block.frontierParams.level) {
    //   throw new Error(
    //     `Invalid frontier vote! The voted block's level must be greater than or equal to the voter level!`,
    //   );
    // }

    this.setFrontierChainDepth(
      block,
      frontierVote.parentChainRoot,
      frontierVote.parentChainDepth + 1,
    );

    // this.ctx.get(FactEmitter).notify(block);
  }

  private setFrontierChainDepth(
    block: BlockFact,
    root: BlockFact | typeof ZERO_BLOCK,
    depth: number,
  ) {
    if (block.parentChainRoot !== root) {
      block.parentChainRoot = root;
      block.parentChainDepth = depth;
      for (const voter of block.children) {
        this.setFrontierChainDepth(voter, root, depth + 1);
      }

      this.initSpendPropagation(block);
    }
  }

  private initSpendPropagation(block: BlockFact) {
    if (block.parentChainRoot === ZERO_BLOCK) {
      this.ctx.get(BlockService).propagateClaims(
        block,
        block.inputs.map((x) => x.utxoIdx),
        block,
      );
      this.ctx.get(BlockService).propagateClaims(
        block.parentBlock ?? error('Internal error!'),
        block.squashedUtxoIdxs,
        block,
      );
    }
  }

  private checkSquashability(block: BlockFact) {
    // Squashing must increase the total size of the tree by at least some factor of the largest squashed size. This can be by:
    //   1. Moving the FV to include more descendants, or
    //   2. Adding another child tree (squash)
    // In case (1) the volume doesn't increase

    const squashes = block.squashes.map((x) => this.ctx.get(BlockService).get(x.blockHash));

    const expectedVolume = squashes.reduce(
      (acc, x) => x === undefined ? acc : acc + x.volume,
      VOLUME_INCLUDES_SELF ? 1 : squashes.length,
    );

    if (squashes.includes(undefined)) {
      if (block.volume < expectedVolume) {
        throw new Error('Invalid volume!');
      }

      return;
    } else {
      if (block.volume !== expectedVolume) {
        throw new Error('Invalid volume!');
      }
    }

    if (squashes.some((x) => x!.parentChainRoot !== block.parentChainRoot)) {
      return;
    }

    if (squashes.length > 0) {
      let largestSquash: BlockFact = squashes[0]!;
      for (const squash of squashes) {
        if (squash!.volume > largestSquash.volume) {
          largestSquash = squash!;
        }
      }

      let totalVolume = 0;
      let parent: BlockFact | typeof ZERO_BLOCK = block;
      do {
        assert(parent !== ZERO_BLOCK);
        totalVolume += parent.volume;
        parent = parent.parentBlock ?? error('Internal error!');
      } while (parent !== largestSquash.parentBlock);

      if (totalVolume < largestSquash.volume * SQUASH_MIN_VOLUME_RATIO) {
        throw new Error('Invalid squash!');
      }
    }
  }

  private linkIo(
    parent: BlockFact,
    child: BlockFact,
    parentOutputIdx: number,
    childInputIdx: number,
  ) {
    if (
      this.ctx.config.graphParameters.enforceTimestampMonotonicity &&
      child.timestamp <
        parent.timestamp + this.ctx.config.graphParameters.minimumGenerationTime
    ) {
      throw new Error(`Generation time is too short!`);
    }

    const verifier = parent.outputs[parentOutputIdx].verifier;
    const groupIdx = child.inputs[childInputIdx].groupIdx;

    // if (parentOutputIdx === parent.frontierOutputIdx) {
    //   const expectedFrontierVote = child.inputs.some((input) =>
    //       Hash.equals(parent.frontier_vote, input.block_hash)
    //     )
    //     ? this.get(parent.frontier_vote)?.frontier_vote
    //     : parent.frontier_vote;
    //   if (
    //     expectedFrontierVote !== undefined &&
    //     !Hash.equals(expectedFrontierVote, child.frontier_vote)
    //   ) {
    //     throw new Error(
    //       `Invalid frontier vote! A tree branch's vote doesn't represent its leaves' votes!`,
    //     );
    //   }
    // }

    // this.checkInputAvailability(child);

    // We set a timeout because enqueueVerification gets this block recursively
    // When we move this to an ingestion method we can remove the timeout.
    // this.ctx.get(ClockService).setTimeout(() => {
    // TODO: Only do this once per unique verifier foreach block
    const hintPrefix = [
      encodeDataTree(CollateralHint.encode({ hint: { CollateralHintVerifier: { groupIdx } } })),
    ];
    if (
      Hash.equals(verifier.contractHash, squashHash) &&
      arrEquals(verifier.params.value!.bytes, EMPTY_ARR)
    ) {
      const isValid = child.squashes.some((x) => Hash.equals(x.blockHash, parent.hash));
      const vote = isValid ? 'FINAL_PASS' : 'FINAL_FAIL';
      try {
        this.ctx.get(LitigationService).litigate(child, hintPrefix, vote);
      } catch (err) {
        console.error(`Litigation failed:`, err);
      }
    } else {
      this.ctx.get(OrchestrationService).launchVerifier(child, verifier, hintPrefix);
    }
    // }, 0);

    // if (
    //   child.verifiers[groupIdx] !== undefined &&
    //   !this.areVerifiersEqual(child.verifiers[groupIdx]!, verifier)
    // ) {
    //   throw new Error(`Cannot have multiple verifiers for the same groupIdx!`);
    // }
    // child.verifiers[groupIdx] = verifier;

    this.ctx.get(BlockService).satisfactionMonitor.callAll(verifier, child);

    if (child.canonicality >= 0n) {
      this.ctx.get(MonitoringService).verifierInputMonitor
        .callAll(verifier, child, childInputIdx);
    }

    this.ctx.get(ClockService).setTimeout(
      () => this.ctx.get(FactEmitter).notify(child),
      0,
    );

    this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(parent);
    this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(child);

    // // Commented out because we're moving to out-of-block collateralizations
    // if (Hash.equals(verifier.contractHash, collateralHash)) {
    //   const { collateral_input_idx, valid, public_key, free_after } =
    //     CollateralContractParams.decode(verifier.params);

    //   if (collateral_input_idx >= 0) {
    //     const input = block.inputs[collateral_input_idx];
    //   } else if (collateral_input_idx === COLLATERAL_INPUT_IDX_INITIAL) {
    //     // Initial posting
    //   } else if (collateral_input_idx === COLLATERAL_INPUT_IDX_ISOLATED) {
    //     // Sending collateral for someone else to include in their link
    //     throw new Error(`Not implemented`);
    //   } else {
    //     throw new Error(`Bad collateral input idx: ${collateral_input_idx}`);
    //   }
    // }

    // // TODO: Use a simpler store; also update FetchService
    // this.ctx.get(BlocksByVerifierStore).mutate(
    //   verifierHash,
    //   (blocks) => blocks ? [...blocks, block] : [block],
    // );
  }
}

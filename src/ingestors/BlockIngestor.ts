import { BlockService } from '../BlockService.ts';
import { Context } from '../Context.ts';
import { BlockFact, FactBase, FactSource, FactType } from '../FactMeta.ts';
import { FactService, headerSize } from '../FactService.ts';
import { IngestionProvider } from '../IngestionProvider.ts';
import { UnspentOutputManager } from '../UnspentOutputManager.ts';
import { BlockRecordSet } from '../record_sets/BlockRecordSet.ts';
import {
  Block,
  BlockOutput,
  FrontierTreeDetail,
  FrontierTreeParams,
} from '../messages.ts';
import { BlockFlag, BlockMeta } from '../BlockMeta.ts';
import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { collateralHash, frontierHash } from '../constants.ts';
import { NUM_FRONTIER_LEVELS } from '../FrontierService2.ts';
import { MonitoringService } from '../MonitoringService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
  CollateralHint,
} from '../collateralMessages.ts';
import { GenerationService } from '../GenerationService.ts';
import { ClockService } from '../ClockService.ts';
import { RenderService } from '../RenderService.ts';
import { FactEmitter } from '../FactEmitter.ts';
import { VerificationService } from '../VerificationService.ts';
import { WeightService } from '../WeightService.ts';

export class BlockIngestor implements IngestionProvider<BlockFact> {
  type = FactType.Block as const;
  isPersistent = true;
  isSigned = true;

  constructor(private ctx: Context) {}

  create(base: FactBase) {
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
      !Hash.equals(block.frontierVote, ZERO_HASH)
    ) {
      throw new Error(`Cannot ingest a block with a frontier vote!`);
    }

    if (
      !this.ctx.config.enableBlockThroughput &&
      base.source !== FactSource.Genesis &&
      block.outputs.some((x) => x.amount !== 0n)
    ) {
      throw new Error(`Cannot ingest a block with coin throughput!`);
    }

    const frontierVote = this.ctx.get(BlockService)
      .get(block.frontierVote, false);

    const meta: BlockMeta = {
      // verifiers: block.bodies.map(() => undefined),

      descWeight: 0n,
      canonicality: 0n,

      flags: BlockFlag.None,
      votes: 0n,
      derivedWork: 0,
      mergeableProbability: 0,
      outputClaims: block.outputs.map((_, idx) =>
        this.ctx.get(BlockService).getClaims({
          blockHash: base.hash,
          outputIdx: idx,
        })
      ),

      isCanonical: frontierVote?.isCanonical !== false &&
        block.inputs.every(
          (x) =>
            this.ctx.get(BlockService).get(x.blockHash, false)?.isCanonical !==
              false,
        ),

      frontierVoteBlock: frontierVote,
      // frontierChainDepth: base.source === FactSource.Genesis ? 0 : undefined,
      frontierChainDepth: Hash.equals(block.frontierVote, ZERO_HASH)
        ? 0
        : undefined,

      frontierVoters: this.ctx.get(BlockService).getVoters(base.hash),

      propagationMask: 0,

      derivedWorkValue: 0,
      derivedWorkError: Infinity,
      mergeableLogProbabilityValue: 0,
      mergeableLogProbabilityError: 0,

      canonicalityOld: 0,
      collateral: 0,

      epochInclusionProofs: new Map(),

      ...this.getFrontierMeta(block),

      persistentSources: [],
    };

    return Object.assign(base, block, meta, {
      type: FactType.Block as const,
    });
  }

  ingest(fact: BlockFact) {
    this.ctx.get(BlockService).blockMonitor.resolveAll(fact.hash, fact);

    // this.ctx.get(EpochInclusionProofService).popEips(fact);

    this.ctx.get(BlockService).getVoters(fact.frontierVote).push(fact);

    if (fact.frontierVoteBlock !== undefined) {
      this.linkFrontier(fact.frontierVoteBlock, fact);
    }

    for (const voter of fact.frontierVoters) {
      voter.frontierVoteBlock = fact;
      this.linkFrontier(fact, voter);
    }

    fact.inputs.forEach((input, idx) => {
      // TODO: Make this case work; just plugin an EMPTY_ARR or an undefined body
      if (fact.bodies[input.groupIdx] === undefined) {
        throw new Error(
          `Invalid groupIdx ${input.groupIdx} on input; only ${fact.bodies.length} bodies present!`,
        );
      }

      const claims = this.ctx.get(BlockService).getClaims(input);
      const claim = { block: fact, inputIdx: idx };
      claims.push(claim);
      this.ctx.get(MonitoringService).claimMonitor.callAll(input, claim);

      const parent = this.ctx.get(BlockService).get(input.blockHash, false);
      if (parent) {
        this.linkIo(parent, fact, input.outputIdx, idx);

        if (claims.length === 1) {
          this.ctx.get(UnspentOutputManager).remove(
            parent.outputs[input.outputIdx].verifier,
            (x) => x.block === parent && x.outputIdx === input.outputIdx,
          );
        }
      }
    });

    fact.outputs.forEach((output, outputIdx) => {
      // TODO: Make this case work; just plugin an EMPTY_ARR or an undefined body
      if (fact.bodies[output.groupIdx] === undefined) {
        throw new Error(
          `Invalid groupIdx ${output.groupIdx} on input; only ${fact.bodies.length} bodies present!`,
        );
      }
      if (output.amount < 0n && outputIdx !== fact.frontierOutputIdx) {
        throw new Error(
          `Negative output amounts are only allowed on frontier outputs!`,
        );
      }

      const claims = this.ctx.get(BlockService).getClaims({
        blockHash: fact.hash,
        outputIdx,
      });
      if (claims.length) {
        claims.forEach(({ block, inputIdx }) =>
          this.linkIo(fact, block, outputIdx, inputIdx)
        );
      } else if (output.amount >= 0n) {
        // We set a timeout because ensureRunning gets this block recursively
        // When we move this to an ingestion method we can remove the timeout.

        // this.ctx.get(ClockService).setTimeout(() => {
        // Also need to consider the fact that this might be a stub block that's immediately going to be claimed (created in BlockBuilder)
        if (claims.length) {
          return;
        }

        this.ctx.get(UnspentOutputManager).insert(output.verifier, {
          block: fact,
          outputIdx,
          amount: output.amount,
        });

        this.ctx.get(GenerationService).ensureRunning(output.verifier);
        // }, 0);
      } else {
        // TODO: What to do in this case; we still need to make the output available if it's required
        // We should add it anyways, and make sure we filter for an appropriate amount when waiting
      }

      if (Hash.equals(output.verifier.contractHash, collateralHash)) {
        const params = CollateralContractParams.decode(output.verifier.params);
        const detailDec = CollateralContractDetail.decode(output.detail);

        if (this.ctx.get(FactService).isSignedByMe(fact)) {
          this.ctx
            .get(FactService)
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

    for (const body of fact.bodies) {
      if (body.byteLength >= headerSize) {
        this.ctx.config.timeProvider.setTimeout(() => {
          try {
            // TODO: Set the fromNode correctly here
            this.ctx.get(FactService).ingest(body, fact.source);
          } catch (err) {
            // If it fails no worries; it just wasn't a valid block
            console.debug(err);
          }
        }, 0);
      }
    }

    // this.ctx.get(BlockSetService).getVoters(block.frontier_vote, -1).push(fact);
    // this.ctx.get(FrontierService).ingestBlock(fact);

    // fact.epochInclusionProofs.forEach((eip) =>
    //   this.ctx.get(EpochInclusionProofService).propagate(fact, eip)
    // );

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

    this.ctx.get(BlockService).updateCanonicalities(
      this.ctx.get(FactService).hackyGetBlocksMatching(),
    );

    this.ctx.maybeGet(BlockRecordSet)?.dispatchAdd(fact);

    this.ctx.get(UnspentOutputManager).tick();

    this.ctx.get(BlockService).updateWeight(fact);
  }

  forget(fact: BlockFact) {
    for (const voter of fact.frontierVoters) {
      voter.frontierVoteBlock = undefined;
    }

    const voters = this.ctx.get(BlockService).getVoters(fact.frontierVote);
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
        const params = CollateralContractParams.decode(output.verifier.params);
        this.ctx.get(FactService).forgetCollateral(params.blockHash, fact);
      }

      this.ctx.get(UnspentOutputManager).remove(
        output.verifier,
        (x) => x.block === fact && x.outputIdx === outputIdx,
      );

      outputIdx++;
    }

    this.ctx.maybeGet(RenderService)?.forget(fact);
    this.ctx.maybeGet(BlockRecordSet)?.dispatchRemove(fact);
  }

  private getFrontierMeta(block: Block) {
    const cb = (output: BlockOutput) =>
      Hash.equals(output.verifier.contractHash, frontierHash);
    const idx = block.outputs.findIndex(cb);
    if (idx === -1 || block.outputs.findLastIndex(cb) !== idx) {
      throw new Error(`Not exactly one frontier output!`);
    }
    const output = block.outputs[idx];
    const frontierParams = FrontierTreeParams.decode(output.verifier.params);
    const frontierDetail = FrontierTreeDetail.decode(output.detail);

    if (
      frontierParams.level < 0 ||
      frontierParams.level >= NUM_FRONTIER_LEVELS
    ) {
      throw new Error(`Invalid frontier level ${frontierParams.level}!`);
    }
    if (frontierDetail.treeWeights.length > NUM_FRONTIER_LEVELS) {
      throw new Error(`Too many tree weights!`);
    }
    for (const weight of frontierDetail.treeWeights) {
      if (weight < 0n) {
        throw new Error(`Invalid tree weight ${weight}!`);
      }
    }

    return { frontierOutputIdx: idx, frontierParams, frontierDetail };
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

    if (frontierVote.frontierParams.level < block.frontierParams.level) {
      throw new Error(
        `Invalid frontier vote! The voted block's level must be greater than or equal to the voter level!`,
      );
    }

    if (frontierVote.frontierChainDepth !== undefined) {
      this.setFrontierChainDepth(block, frontierVote.frontierChainDepth + 1);
    }

    // this.ctx.get(FactEmitter).notify(block);
  }

  private setFrontierChainDepth(block: BlockFact, depth: number) {
    if (block.frontierChainDepth !== depth) {
      if (block.frontierChainDepth !== undefined) {
        throw new Error(`Internal error`);
      }
      block.frontierChainDepth = depth;
      for (const voter of block.frontierVoters) {
        this.setFrontierChainDepth(voter, depth + 1);
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

    if (!parent.isCanonical) {
      // this.ctx.get(BlockService).setCanonicality(child, false);
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
      CollateralHint.encode({
        hint: { CollateralHintVerifier: { groupIdx } },
      }),
    ];
    this.ctx.get(VerificationService)
      .enqueueVerification(child, verifier, hintPrefix, 0);
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

    this.ctx.config.timeProvider.setTimeout(
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

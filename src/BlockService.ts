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
  AccountContractParams,
  Block,
  BlockInput,
  BlockOutput,
  BlockSet,
  EpochInclusionParams,
  EpochInclusionProof,
  FrontierTreeDetail,
  FrontierTreeParams,
  Verifier,
} from './messages.ts';
import { NodeService } from './NodeService.ts';
import { QaDebugger } from './QaDebugger.ts';
import { arrEquals } from './util/buffer.ts';
import { Hash, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import {
  BlockFact,
  Collateralization,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from './FactMeta.ts';
import { FactService } from './FactService.ts';
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
import { Node } from './NodeService.ts';
import { WeightService } from './WeightService.ts';
import { MonitoringService } from './MonitoringService.ts';
import { UnspentOutputManager } from './UnspentOutputManager.ts';
import { neverAbort } from './util/abortable.ts';
import { GenerationService } from './GenerationService.ts';
import { raceTruthy } from './util/MaybePromise.ts';
import { BlockRecordSet } from './record_sets/BlockRecordSet.ts';
import { GenesisService } from './GenesisService.ts';

export const CHALLENGE_PRICE = 10n;

export const BASE_WORK = 10n;

export class BlockService {
  private claimsByOutput = new Map<HashPrimitive, OutputClaim[]>();
  private frontierVoters = new Map<HashPrimitive, BlockFact[]>();

  public blockMonitor = new ResolvingMonitor<Hash, BlockFact>((h) =>
    h.toPrimitive()
  ); // Key is block hash
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

  public createFact(
    base: FactBase,
    mutator?: (fact: BlockFact) => void,
  ): BlockFact {
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

    const frontierVote = this.get(block.frontierVote, false);

    const meta: BlockMeta = {
      original: block,

      // verifiers: block.bodies.map(() => undefined),

      canonicality: -1n,

      flags: BlockFlag.None,
      votes: 0n,
      derivedWork: 0,
      mergeableProbability: 0,
      outputClaims: block.outputs.map((_, idx) =>
        this.getClaims({ blockHash: base.hash, outputIdx: idx })
      ),

      isCanonical: frontierVote?.isCanonical !== false &&
        block.inputs.every(
          (x) => this.get(x.blockHash, false)?.isCanonical !== false,
        ),

      frontierChainDepth: base.source === FactSource.Genesis ? 0 : undefined,

      frontierVoters: this.getVoters(base.hash),

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
    const fact: BlockFact = Object.assign(base, block, meta, {
      type: FactType.Block as const,
    });

    if (mutator !== undefined) {
      mutator(fact);
    }

    this.blockMonitor.resolveAll(fact.hash, fact);

    // this.ctx.get(EpochInclusionProofService).popEips(fact);

    this.getVoters(fact.frontierVote).push(fact);
    if (frontierVote !== undefined) {
      this.linkFrontier(frontierVote, fact);
    }

    for (const voter of fact.frontierVoters) {
      this.linkFrontier(fact, voter);
    }

    fact.inputs.forEach((input, idx) => {
      // TODO: Make this case work; just plugin an EMPTY_ARR or an undefined body
      if (fact.bodies[input.groupIdx] === undefined) {
        throw new Error(
          `Invalid groupIdx ${input.groupIdx} on input; only ${fact.bodies.length} bodies present!`,
        );
      }

      const claims = this.getClaims(input);
      const claim = { block: fact, inputIdx: idx };
      claims.push(claim);
      this.ctx.get(MonitoringService).claimMonitor.callAll(input, claim);

      const parent = this.get(input.blockHash, false);
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

      const claims = this.getClaims({ blockHash: base.hash, outputIdx });
      if (claims.length) {
        claims.forEach(({ block, inputIdx }) =>
          this.linkIo(fact, block, outputIdx, inputIdx)
        );
      } else if (output.amount >= 0n) {
        this.ctx.get(UnspentOutputManager).insert(output.verifier, {
          block: fact,
          outputIdx,
          amount: output.amount,
        });
        this.ctx.get(GenerationService).ensureRunning(output.verifier);
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
      this.checkInputAvailability(fact);
    }

    for (const body of fact.bodies) {
      if (body.byteLength > 0) {
        try {
          // TODO: Set the fromNode correctly here
          this.ctx.get(FactService).ingest(body, fact.source);
        } catch (_err) {
          // If it fails no worries; it just wasn't a valid block
        }
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

    return fact;
  }

  public forget(block: BlockFact) {
    for (const voter of block.frontierVoters) {
      voter.frontierVoteBlock = undefined;
    }

    const voters = this.getVoters(block.frontierVote);
    const idx = voters.indexOf(block);
    if (idx !== -1) {
      voters.splice(idx, 1);
    }

    for (const input of block.inputs) {
      const claims = this.getClaims(input);
      const idx = claims.findIndex((claim) => claim.block === block);
      if (idx !== -1) {
        claims.splice(idx, 1);
      }
    }

    let outputIdx = 0;
    for (const output of block.outputs) {
      if (Hash.equals(output.verifier.contractHash, collateralHash)) {
        const params = CollateralContractParams.decode(output.verifier.params);
        this.ctx.get(FactService).forgetCollateral(params.blockHash, block);
      }

      this.ctx.get(UnspentOutputManager).remove(
        output.verifier,
        (x) => x.block === block && x.outputIdx === outputIdx,
      );

      outputIdx++;
    }
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

    block.frontierVoteBlock = frontierVote;
    if (frontierVote.frontierChainDepth !== undefined) {
      this.setFrontierChainDepth(block, frontierVote.frontierChainDepth + 1);
    }
  }

  private setFrontierChainDepth(block: BlockFact, depth: number) {
    if (block.frontierChainDepth !== undefined) {
      throw new Error(`Internal error`);
    }
    block.frontierChainDepth = depth;
    for (const voter of block.frontierVoters) {
      this.setFrontierChainDepth(voter, depth + 1);
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
      this.setCanonicality(child, false);
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

    this.checkInputAvailability(child);

    // TODO: Only do this once per unique verifier foreach block
    const hintPrefix = [
      CollateralHint.encode({ hint: { CollateralHintVerifier: { groupIdx } } }),
    ];
    this.ctx
      .get(VerificationService)
      .enqueueVerification(child, verifier, hintPrefix, 0);

    // if (
    //   child.verifiers[groupIdx] !== undefined &&
    //   !this.areVerifiersEqual(child.verifiers[groupIdx]!, verifier)
    // ) {
    //   throw new Error(`Cannot have multiple verifiers for the same groupIdx!`);
    // }
    // child.verifiers[groupIdx] = verifier;

    this.satisfactionMonitor.callAll(verifier, child);

    if (child.canonicality >= 0n) {
      this.ctx.get(MonitoringService).verifierInputMonitor
        .callAll(verifier, child, childInputIdx);
    }

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
          this.ctx.get(ContractClassifierService).isCharity(verifier)
            ? acc + amount
            : acc,
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
    const cache = this.ctx.get(WeightService).makeCache();
    for (const block of blocks) {
      const newCanonicality = this.ctx.get(WeightService)
        .getCanonicality(block, cache);
      if (newCanonicality !== block.canonicality) {
        block.canonicality = newCanonicality;
        this.ctx.maybeGet(BlockRecordSet)?.dispatchUpdate(block);
      }
    }
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
            claim.block.inputs.filter(({ blockHash }) =>
              this.get(blockHash, false)
            ).length;
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
    return initialClaimFor > CHALLENGE_PRICE
      ? initialClaimFor - CHALLENGE_PRICE
      : 0n;
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

  public getBlocksByInput(input: BlockInput) {
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
    for (let i = 0; i < block.bodies.length; i++) {
      const hint = CollateralHint.encode({
        hint: { CollateralHintVerifier: { groupIdx: i } },
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
    input: BlockInput,
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
    const promises: { inputPromise: Promise<BlockFact>; input: BlockInput }[] =
      [];
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

import { BlockFlag, BlockMeta } from './BlockMeta.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';
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
import Context from './Context.ts';
import VerificationService from './VerificationService.ts';
import Logger from './Logger.ts';
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
import NodeService from './NodeService.ts';
import QaDebugger from './QaDebugger.ts';
import { arrEquals } from './util/buffer.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import {
  BlockFact,
  BlockSetFact,
  Collateralization,
  Fact,
  FactBase,
  FactSource,
  FactType,
} from '~/sbl/FactMeta.ts';
import FactService from '~/sbl/FactService.ts';
import ContractClassifierService from '~/sbl/ContractClassifierService.ts';
import { assert, neverPromise, todo } from '~/sbl/util/functional.ts';
import FrontierService from '~/sbl/FrontierService.ts';
import PublicKeyService from '~/sbl/PublicKeyService.ts';
import LitigationService from '~/sbl/LitigationService.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
  CollateralHint,
} from '~/sbl/collateralMessages.ts';
import FrontierService2 from '~/sbl/FrontierService2.ts';
import { ResolvingMonitor, WatchingMonitor } from './util/Monitor.ts';
import { MaybePromise } from '~/sbl/util/types.ts';
import UnclaimedOutputService from '~/sbl/UnclaimedOutputService.ts';
import CollateralUtil, { CONTEST_TYPE_FINAL } from '~/sbl/CollateralUtil.ts';
import GenerationService from '~/sbl/GenerationService.ts';

export const CHALLENGE_PRICE = 10n;

export const BASE_WORK = 10n;

export const neverAbort = new AbortController().signal;

export default class BlockService {
  private claimsByOutput = new Map<
    HashPrimitive,
    { block: BlockFact; inputIdx: number }[]
  >();
  private frontierVoters = new Map<HashPrimitive, BlockFact[]>();

  public blockMonitor = new ResolvingMonitor<BlockFact, Hash>((h) => h); // Key is block hash
  public satisfactionMonitor = new WatchingMonitor<BlockFact, Verifier>((v) =>
    Hash.digest(Verifier.encode(v))
  ); // Key is input verifier

  constructor(private ctx: Context) {}

  public hash(block: Block, signer: Hash) {
    return Hash.digestParts(signer, Block.encode(block));
  }

  public create(block: Block): BlockFact {
    // Immortalization attempts to spread the block as widely as possible to make it immutable and hard to change.

    const data = this.ctx.get(FactService)
      .compose(block, Block, FactType.Block);

    // I know we're encoding/decoding redundantly here, and we can possibly make this faster later, but for now let's make everything go through the same code path
    const fact = this.ctx.get(FactService).ingest(
      data,
      FactSource.Local,
      this.ctx.get(NodeService).getSelfNode(),
    );
    if (fact.type !== FactType.Block) {
      throw new Error(`Internal error! Invalid fact type ${fact.type}`);
    }

    this.ctx.get(FactService).publish(fact);

    // console.log(
    //   'create',
    //   fact.outputs.find((output) =>
    //     Hash.equals(output.verifier.contract_hash, frontierHash)
    //   ),
    // );

    return fact;
  }

  public createFact(
    base: FactBase,
    mutator?: (fact: BlockFact) => void,
  ): BlockFact {
    const block = Block.decode(base.message);

    if (block.timestamp > BigInt(this.ctx.config.timeProvider.now())) {
      throw new Error(`Discarding block because the timestamp is too late`);
    }

    // console.log(
    //   `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
    //     trunc(bin2hex(block.verifier.params), 100)
    //   } -> ${trunc(bin2hex(block.body), 100)}`,
    // );
    // console.log(block);

    const meta: BlockMeta = {
      original: block,

      verifiers: [],

      isEpoch: false,

      receivedTimestamp: this.ctx.config.timeProvider.now(),
      flags: BlockFlag.None,
      votes: 0n,
      derivedWork: 0,
      mergeableProbability: 0,
      outputClaims: block.outputs.map((_, idx) =>
        this.getClaims({ block_hash: base.hash, output_idx: idx })
      ),

      isCanonical:
        this.get(block.frontier_vote, false)?.isCanonical !== false &&
        block.inputs.every((x) =>
          this.get(x.block_hash, false)?.isCanonical !== false
        ),

      frontierVoters: getOrCreate(
        this.frontierVoters,
        base.hash.toPrimitive(),
        () => [],
      ),

      propagationMask: 0,

      derivedWorkValue: 0,
      derivedWorkError: Infinity,
      mergeableLogProbabilityValue: 0,
      mergeableLogProbabilityError: 0,

      canonicality: 0,
      collateral: 0,

      epochInclusionProofs: new Map(),

      // parentBlockSets: this.ctx.get(BlockSetService).getParents(base.hash),
      parentBlockSets: [],
      highestParentChain: [], // TODO: Literal empty array

      ...this.getFrontierMeta(block),
    };
    const fact: BlockFact = Object.assign(
      base,
      block,
      meta,
      { type: FactType.Block as const },
    );

    if (mutator !== undefined) {
      mutator(fact);
    }

    this.blockMonitor.resolveAll(fact.hash, fact);

    // this.ctx.get(EpochInclusionProofService).popEips(fact);

    getOrCreate(this.frontierVoters, fact.frontier_vote.toPrimitive(), () => [])
      .push(fact);
    const frontierVote = this.get(fact.frontier_vote, false);
    if (frontierVote !== undefined) {
      this.linkFrontier(frontierVote, fact);
    }

    for (const voter of fact.frontierVoters) {
      this.linkFrontier(fact, voter);
    }

    fact.inputs.forEach((input, idx) => {
      const claims = this.getClaims(input);
      claims.push({ block: fact, inputIdx: idx });

      const parent = this.get(input.block_hash);
      if (parent) {
        this.linkIo(parent, fact, input.output_idx, idx);

        if (claims.length === 1) {
          this.ctx.get(UnclaimedOutputService).removeUnclaimed(
            parent,
            input.output_idx,
          );
        }
      }
    });

    fact.outputs.forEach(({ verifier, amount, detail }, outputIdx) => {
      const claims = this.getClaims({
        block_hash: base.hash,
        output_idx: outputIdx,
      });
      if (claims.length) {
        claims.forEach(({ block, inputIdx }) =>
          this.linkIo(fact, block, outputIdx, inputIdx)
        );
      } else {
        this.ctx.get(UnclaimedOutputService).addUnclaimed(fact, outputIdx);
      }

      this.ctx.get(GenerationService).enqueueGeneration(
        verifier,
        detail,
        0,
      );

      if (Hash.equals(verifier.contract_hash, accountHash)) {
        const params = AccountContractParams.decode(verifier.params);
        this.ctx.get(PublicKeyService).addPublicKey(params.public_key);
      }

      if (Hash.equals(verifier.contract_hash, collateralHash)) {
        const params = CollateralContractParams.decode(verifier.params);
        const detailDec = CollateralContractDetail.decode(detail);
        this.ctx.get(PublicKeyService).addPublicKey(detailDec.public_key);
        if (fact.isSignedByMe) {
          this.ctx.get(FactService)
            .updateValidity(params.block_hash, detailDec.hints, detailDec.vote);
        }

        this.ctx.get(FactService).addCollateral(params.block_hash, {
          collateralBlock: fact,
          collateralOutputIdx: outputIdx,
          detail: detailDec,
          amount,
        });

        // const contestedBlock = this.ctx.get(FactService).get(params.block_hash);
        // if (contestedBlock !== undefined) {
        //   if (contestedBlock.type !== FactType.Block) {
        //     throw new Error(`Cannot contest a non-block`);
        //   }
        //   this.ctx.get(LitigationService).scheduleResolution(contestedBlock);
        // }
      }

      // if (Hash.equals(verifier.contract_hash, epochInclusionHash)) {
      //   const { hash } = EpochInclusionParams.decode(verifier.params);
      //   this.ctx.get(EpochContract).addInclusionHash(fact, outputIdx, hash);
      // }
    });

    if (fact.inputs.length === 0) {
      this.checkInputAvailability(fact);
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

  private getFrontierMeta(block: Block) {
    const cb = (output: BlockOutput) =>
      Hash.equals(output.verifier.contract_hash, frontierHash);
    const idx = block.outputs.findIndex(cb);
    if (idx === -1 || block.outputs.findLastIndex(cb) !== idx) {
      throw new Error(`Not exactly one frontier output!`);
    }
    const output = block.outputs[idx];
    return {
      frontierOutputIdx: idx,
      frontierParams: FrontierTreeParams.decode(output.verifier.params),
      frontierDetail: FrontierTreeDetail.decode(output.detail),
    };
  }

  public compare(a: BlockFact, b: BlockFact) {
    // TODO: Use a frontier block

    if (a === b) {
      return 0;
    }

    const aHeight = a.highestParentChain.length;
    const bHeight = b.highestParentChain.length;

    const aWork = aHeight ? a.highestParentChain[aHeight - 1].votes : a.votes;
    const bWork = bHeight ? b.highestParentChain[bHeight - 1].votes : b.votes;
    if (aWork === undefined || bWork === undefined) {
      return 0;
    }
    if (aWork !== bWork) {
      // Unmerged chains but we can still order them by placing the higher work one first
      return bWork - aWork;
    }

    if (aHeight !== bHeight) {
      // Unmerged chains but we can still order them by placing the higher one first
      return bHeight - aHeight;
    }

    for (let i = 0; i < aHeight; i++) {
      if (a.highestParentChain[i] === b.highestParentChain[i]) {
        const aHash = i ? a.highestParentChain[i - 1].hash : a.hash;
        const bHash = i ? b.highestParentChain[i - 1].hash : b.hash;
        const merge = a.highestParentChain[i];
        if (
          Hash.equals(aHash, merge.left_child) &&
          Hash.equals(bHash, merge.right_child)
        ) {
          return -1;
        } else if (
          Hash.equals(aHash, merge.right_child) &&
          Hash.equals(bHash, merge.left_child)
        ) {
          return 1;
        } else {
          throw new Error(`Unexpected merge children`);
        }
      }
    }

    console.warn(`Chains aren't merged yet!`);
    return 0;
  }

  public sort(items: { block: BlockFact }[], frontier: BlockSetFact) {
    throw new Error(`Unimplemented`);
  }

  private linkFrontier(frontierVote: BlockFact, block: BlockFact) {
    if (frontierVote.frontierParams.level < block.frontierParams.level) {
      throw new Error(
        `Invalid frontier vote! The voted block's level must be greater than or equal to the voter level!`,
      );
    }
  }

  private linkIo(
    parent: BlockFact,
    child: BlockFact,
    parentOutputIdx: number,
    childInputIdx: number,
  ) {
    if (!parent.isCanonical) {
      this.setCanonicality(child, false);
    }

    const verifier = parent.outputs[parentOutputIdx].verifier;

    if (Hash.equals(verifier.contract_hash, frontierHash)) {
      const expectedFrontierVote = child.inputs.some((input) =>
          Hash.equals(parent.frontier_vote, input.block_hash)
        )
        ? this.get(parent.frontier_vote)?.frontier_vote
        : parent.frontier_vote;
      if (
        expectedFrontierVote !== undefined &&
        !Hash.equals(expectedFrontierVote, child.frontier_vote)
      ) {
        throw new Error(
          `Invalid frontier vote! A tree branch's vote doesn't represent its leaves' votes!`,
        );
      }
    }

    this.checkInputAvailability(child);

    // TODO: Only do this once per unique verifier foreach block
    this.ctx.get(VerificationService).enqueueVerification(
      child,
      verifier,
      [CollateralHint.encode({
        hint: { CollateralHintVerifier: { input_idx: childInputIdx } },
      })],
      0,
    );

    if (
      child.verifiers.some((v2) =>
        Hash.equals(verifier.contract_hash, v2.contract_hash) &&
        arrEquals(verifier.params, v2.params)
      )
    ) {
      return;
    }

    child.verifiers.push(verifier);

    this.satisfactionMonitor.callAll(verifier, child);

    // // Commented out because we're moving to out-of-block collateralizations
    // if (Hash.equals(verifier.contract_hash, collateralHash)) {
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
      block.inputs.every(({ block_hash, output_idx }) => {
        const block = this.get(block_hash);
        if (block !== undefined) {
          const { amount, verifier } = block.outputs[output_idx];
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

  private setCanonicality(block: BlockFact, isCanonical: boolean) {
    if (isCanonical !== block.isCanonical) {
      block.isCanonical = isCanonical;

      for (const output of block.outputClaims) {
        for (const claim of output) {
          if (isCanonical) {
            this.setCanonicality(
              claim.block,
              this.get(claim.block.frontier_vote, false)?.isCanonical !==
                  false &&
                claim.block.inputs.every((x) =>
                  this.get(x.block_hash, false)?.isCanonical !== false
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
      const inputBlock = this.get(input.block_hash);
      const inputCanonicality = inputBlock === undefined
        ? delta
        : Math.min(delta, inputBlock.canonicality);
      return Math.min(acc, inputCanonicality);
    }, Infinity);

    if (canonicality !== block.canonicality) {
      block.canonicality = canonicality;
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

    for (const { block_hash } of block.inputs) {
      const input = this.get(block_hash);
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
                (acc, claim) => Math.max(acc, claim.block.canonicality),
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
        if (claim.block.canonicality > 0) {
          sum += claim.block.derivedWorkValue /
            claim.block.inputs.filter(({ block_hash }) => this.get(block_hash))
              .length;
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
      .map(({ block_hash }) => this.get(block_hash))
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
            o.verifier.contract_hash,
            block.verifier.contract_hash,
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

  public getBlockIndex(block: BlockFact): bigint {
    // Walk up towards frontier; computing the unique index that this block is aiming to be included at
    throw new Error(`Not implemented`);
  }

  public getClaims({ block_hash, output_idx }: BlockInput) {
    // TODO: I think this is secure (resistant to collisions), but should verify
    return getOrCreate(
      this.claimsByOutput,
      Hash.composePrimitives(
        block_hash.toPrimitive(),
        Hash.fromLiteral32(output_idx).toPrimitive(),
      ),
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
    for (const { block_hash, output_idx } of block.inputs) {
      const inBlock = this.get(block_hash);
      if (inBlock) {
        const claims = inBlock.outputClaims[output_idx];
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
    return Hash.equals(a.contract_hash, b.contract_hash) &&
      arrEquals(a.params, b.params);
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
    return this.ctx.get(FactService).hackyGetBlocksMatching((block) =>
      block.verifiers.some((v) =>
        Hash.equals(v.contract_hash, verifier.contract_hash) &&
        arrEquals(v.params, verifier.params)
      )
    );
  }

  public getBlocksByInput(input: BlockInput) {
    return this.ctx.get(FactService).hackyGetBlocksMatching((block) =>
      block.inputs.some((y) =>
        Hash.equals(y.block_hash, input.block_hash) &&
        y.output_idx === input.output_idx
      )
    );
  }

  public getBlocksByOutput(verifier: Verifier) {
    return this.ctx.get(FactService).hackyGetBlocksMatching().flatMap((
      block,
    ) =>
      block.outputs.flatMap((y, idx) =>
        Hash.equals(y.verifier.contract_hash, verifier.contract_hash) &&
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
    return this.ctx.get(FactService).hackyGetBlocksMatching().flatMap((
      block,
    ) =>
      block.outputs.flatMap((y, idx) =>
        Hash.equals(y.verifier.contract_hash, contractHash) &&
          cond(y.verifier.params)
          ? [{ block, idx }]
          : []
      )
    );
  }

  public waitForBlock(hash: Hash, cancelSignal: AbortSignal) {
    const got = this.get(hash);
    if (got) {
      return got;
    }
    return this.blockMonitor.waitFor(hash, cancelSignal);
  }

  public async getSelfVerification(block: BlockFact) {
    const myCollateral = this.getBlocksByOutput({
      contract_hash: collateralHash,
      params: CollateralContractParams.encode({ block_hash: block.hash }),
    }).filter(({ block }) => block.source === FactSource.Local); // TODO: Filter by signature so we get our blocks even if someone else sent them to us

    // myCollateral
  }

  // Note that contestations still may be in progress
  public async waitForVerification(
    block: BlockFact,
    cancelSignal = neverAbort,
  ) {
    for (let i = 0; i < block.inputs.length; i++) {
      const hint = CollateralHint.encode({
        hint: { CollateralHintVerifier: { input_idx: i } },
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

  public doesBlockSatisfy(
    block: BlockFact,
    verifier: Verifier,
    cancelSignal: AbortSignal,
  ) {
    if (cancelSignal.aborted) {
      return neverPromise;
    }

    // TODO: Cache unused abort controllers
    const controller = new AbortController();
    const promises: { inputPromise: Promise<BlockFact>; outputIdx: number }[] =
      [];
    for (const input of block.inputs) {
      const inputPromise = this.ctx.get(BlockService).waitForBlock(
        input.block_hash,
        controller.signal,
      );
      if (inputPromise instanceof Promise) {
        cancelSignal.addEventListener('abort', () => controller.abort());
        promises.push({ inputPromise, outputIdx: input.output_idx });
      } else {
        const test = inputPromise.outputs[input.output_idx].verifier;
        if (this.areVerifiersEqual(test, verifier)) {
          controller.abort();
          return true;
        }
      }
    }

    let remaining = promises.length;
    if (remaining === 0) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      promises.forEach(async ({ inputPromise, outputIdx }) => {
        const test = (await inputPromise).outputs[outputIdx].verifier;
        if (this.areVerifiersEqual(test, verifier)) {
          controller.abort();
          resolve(true);
        } else {
          if (--remaining === 0) {
            resolve(false);
          }
        }
      });
    });
  }
}

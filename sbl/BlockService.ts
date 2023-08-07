import {
  BlockCollateralization,
  BlockExt,
  BlockFlag,
  BlockMeta,
  BlockSource,
} from './BlockMeta.ts';
import { MessageType } from './ConnectionService.ts';
import { collateralHash, epochHash, epochInclusionHash } from './constants.ts';
import Context from './Context.ts';
import EpochContract from './EpochContract.ts';
import EpochInclusionProofService from '~/sbl/EpochInclusionProofService.ts';
import ExecutorLauncherService from './ExecutorLauncherService.ts';
import Logger from './Logger.ts';
import {
  Block,
  BlockInput,
  BlockSet,
  CollateralContractParams,
  EpochInclusionParams,
  EpochInclusionProof,
  Verifier,
} from './messages.ts';
import NodeService from './NodeService.ts';
import PacketCoder, { SIGNATURE_LENGTH } from './PacketCoder.ts';
import QaDebugger from './QaDebugger.ts';
import { arrEquals } from './util/buffer.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';

interface CollateralSummary {
  // 3 cases:
  //   1. No collateral. Ledger is empty and resolver is block
  //   2. Unresolved collateral. Ledger is non-empty and resolver is undefined
  //   3. Resolved collateral. Ledger is non-empty and resolver is defined
  postedAmountFor: bigint;
  postedAmountAgainst: bigint;
  implicitAmountAgainst: bigint;
  ledger: BlockCollateralization[];
  resolver?: BlockExt;
}

export const CHALLENGE_PRICE = 10n;

export default class BlockService {
  private blocksByHash = new Map<HashPrimitive, BlockExt>();
  private claimsByOutput = new Map<
    HashPrimitive,
    { block: BlockExt; inputIdx: number }[]
  >();
  private collateralByBlockHash = new Map<
    HashPrimitive,
    BlockCollateralization[]
  >();

  private onNewBlockListeners = new Map<
    HashPrimitive, // Key is verifier hash
    ((block: BlockExt) => void)[]
  >();
  private onCanonicalBlockListeners = new Map<
    HashPrimitive,
    ((block: BlockExt) => void)[]
  >();
  private onCanonicalBodyListeners = new Map<
    HashPrimitive,
    ((body: Uint8Array) => void)[]
  >();

  constructor(private ctx: Context) {}

  public hash(block: Block, signer: Hash) {
    return Hash.digestParts(signer, Block.encode(block));
  }

  // Create block - (cfg: )
  // Sign & create bytes
  // Ingest
  // Publish?

  public create(block: Block, publish = true, immortalize = false): BlockExt {
    // Immortalization attempts to spread the block as widely as possible to make it immutable and hard to change.

    // Sign, publish, ingest, return hash

    const data = this.ctx.get(PacketCoder).encode(
      block,
      Block,
      MessageType.Block,
    );

    // I know we're encoding/decoding redundantly here, and we can possibly make this faster later, but for now let's make everything go through the same code path
    const blockExt = this.ingest(data, BlockSource.Local);

    if (blockExt === undefined) {
      throw new Error(`Invalid block provided (maybe bad timestamp)?`);
    }

    if (publish) {
      this.publish(blockExt);
    }

    return blockExt;
  }

  // TODO: Test that whatever order we ingest blocks, it all ends up the same
  public ingest(data: Uint8Array, source: BlockSource): BlockExt | undefined {
    const blockHash = Hash.digest(data);
    if (this.blocksByHash.has(blockHash.toPrimitive())) {
      return this.blocksByHash.get(blockHash.toPrimitive());
    }

    const signature = data.subarray(0, SIGNATURE_LENGTH);
    if (signature.byteLength !== SIGNATURE_LENGTH) {
      throw new Error(
        `Signature length (${signature.byteLength}) is not exactly ${SIGNATURE_LENGTH}`,
      );
    }

    if (data[SIGNATURE_LENGTH] !== MessageType.Block) {
      throw new Error(
        `Cannot ingest non-block (${data[SIGNATURE_LENGTH]}) as a block`,
      );
    }

    const block = Block.decode(data.subarray(SIGNATURE_LENGTH + 1));

    if (block.timestamp > BigInt(this.ctx.config.timeProvider.now())) {
      this.ctx.get(Logger).info('discarding_block', {
        blockHash,
        signature,
        block,
        now: BigInt(this.ctx.config.timeProvider.now()),
      });
      return;
    }

    this.ctx.get(Logger).info('ingesting_block', {
      blockHash,
      block,
      verifiers: block.inputs.map((input) => {
        const inBlock = this.get(input.block_hash);
        return inBlock
          ? this.ctx.get(QaDebugger).debugQuestion(
            inBlock.outputs[input.output_idx].verifier,
          )
          : null;
      }),
    });

    // console.log(
    //   `Ingesting block ${block.verifier.contract_hash.toHex()} : ${
    //     trunc(bin2hex(block.verifier.params), 100)
    //   } -> ${trunc(bin2hex(block.body), 100)}`,
    // );
    // console.log(block);

    const meta: BlockMeta = {
      hash: blockHash,
      nonce: Math.random(),

      source,

      data,
      signature,

      verifiers: [],

      fromNodes: [],
      toNodes: [],

      isEpoch: false,

      receivedTimestamp: this.ctx.config.timeProvider.now(),
      flags: BlockFlag.Null,
      derivedWork: 0,
      mergeableProbability: 0,
      outputClaims: block.outputs.map((_, idx) =>
        this.getClaims({ block_hash: blockHash, output_idx: idx }).map((x) =>
          x.block
        )
      ),
      propagationMask: 0,

      derivedWorkValue: 0,
      derivedWorkError: Infinity,
      mergeableLogProbabilityValue: 0,
      mergeableLogProbabilityError: 0,

      canonicality: 0,
      collateral: 0,

      collateralizations: getOrCreate(
        this.collateralByBlockHash,
        blockHash.toPrimitive(),
        () => [],
      ),

      epochInclusionProofs: new Map(),

      backtrace: new Error().stack,
    };
    const blockExt = Object.assign(block, meta);
    this.blocksByHash.set(blockHash.toPrimitive(), blockExt);

    this.ctx.get(EpochInclusionProofService).popEips(blockExt);

    blockExt.inputs.forEach((input, idx) => {
      const parent = this.get(input.block_hash);
      if (parent) {
        this.linkBlocks(parent, blockExt, input.output_idx, idx);
      }

      this.getClaims(input).push({ block: blockExt, inputIdx: idx });
    });

    block.outputs.forEach(({ verifier, amount }, outputIdx) => {
      this.getClaims({ block_hash: blockHash, output_idx: outputIdx })
        .forEach(({ block, inputIdx }) =>
          this.linkBlocks(blockExt, block, outputIdx, inputIdx)
        );

      this.ctx.get(ExecutorLauncherService).enqueueGeneration(verifier, 0);

      if (Hash.equals(verifier.contract_hash, collateralHash)) {
        const params = CollateralContractParams.decode(verifier.params);
        getOrCreate(
          this.collateralByBlockHash,
          params.block_hash.toPrimitive(),
          () => [],
        ).push({ block: blockExt, params, amountDelta: amount, outputIdx });
      }

      if (Hash.equals(verifier.contract_hash, epochInclusionHash)) {
        const { hash } = EpochInclusionParams.decode(verifier.params);
        this.ctx.get(EpochContract).addInclusionHash(blockExt, outputIdx, hash);
      }
    });

    blockExt.epochInclusionProofs.forEach((eip) =>
      this.ctx.get(EpochInclusionProofService).propagate(blockExt, eip)
    );

    // this.updateDerivedWork(blockExt);

    // const samples = PoissonDistribution.sample(
    //   Number(this.getWork(blockExt)) * this.getSamplesPerWork(),
    // );
    // if (samples > 0) {
    //   this.ctx.get(DerivedWorkService).addSample(blockExt);
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

    return blockExt;
  }

  public publish(block: BlockExt) {
    this.ctx.get(NodeService).getAll().forEach((node) => {
      if (!node.knownObjects.has(block)) {
        node.knownObjects.add(block);
        block.toNodes.push(node);
        node.defaultConn?.sendReliable(block.data);
      }
    });
  }

  // This is called whenever an input becomes available
  private linkBlocks(
    parent: BlockExt,
    child: BlockExt,
    parentOutputIdx: number,
    childInputIdx: number,
  ) {
    const verifier = parent.outputs[parentOutputIdx].verifier;

    if (
      child.inputs.every(({ block_hash }) => this.get(block_hash) !== undefined)
    ) {
      let inputSum = child.inputs.reduce(
        (acc, { block_hash, output_idx }) =>
          acc + this.get(block_hash)!.outputs[output_idx].amount,
        0n,
      );
      const outputSum = child.outputs.reduce(
        (acc, { amount }) => acc + amount,
        0n,
      );
      if (
        child.inputs.some(({ block_hash, output_idx }) =>
          Hash.equals(
            this.get(block_hash)!.outputs[output_idx].verifier.contract_hash,
            epochHash,
          )
        )
      ) {
        inputSum += 1000000n;
      }
      if (inputSum !== outputSum) {
        throw new Error(
          `Input sum (${inputSum}) does not equal the output sum (${outputSum}) for block ${child.hash.toHex()}`,
        );
      }
    }

    if (
      child.verifiers.some((v2) =>
        Hash.equals(verifier.contract_hash, v2.contract_hash) &&
        arrEquals(verifier.params, v2.params)
      )
    ) {
      return;
    }

    child.verifiers.push(verifier);

    const verifierHash = Hash.digest(Verifier.encode(verifier));

    this.ctx.get(ExecutorLauncherService).enqueueVerification(
      child,
      verifier,
      0,
    );

    this.onNewBlockListeners.get(verifierHash.toPrimitive())?.forEach((cb) =>
      cb(child)
    );

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

  public linkNewAncestor(parent: BlockExt, child: BlockExt) {}

  public linkNewDescendant(parent: BlockExt, child: BlockExt) {}

  // public getCollateralOutput(block: BlockExt, ancestorOutputIdx?: number) {
  //   let res: { idx: number; params: CollateralContractParams } | undefined;

  //   block.outputs.forEach(({ verifier }, idx) => {
  //     if (Hash.equals(verifier.contract_hash, collateralHash)) {
  //       const params = CollateralContractParams.decode(verifier.params);
  //       if (
  //         ancestorOutputIdx === undefined
  //           ? params.collateral_input_idx === COLLATERAL_INPUT_IDX_INITIAL
  //           : block.inputs[params.collateral_input_idx].output_idx ===
  //             ancestorOutputIdx
  //       ) {
  //         if (res === undefined) {
  //           res = { idx, params };
  //         } else {
  //           throw new Error(
  //             `Multiple outputs consuming single collateral input (${res.idx} and ${idx})!`,
  //           );
  //         }
  //       }
  //     }
  //   });

  //   return res;
  // }

  // Hash inversions can be provided via 2 methods:
  //   Simple provisions, where the reward is paid only to the original hash poster
  //   The data protocol, where the reward can be paid to someone else
  // A hash inversion request CLAIMS the 500 and incentivizes the response (by either of the 2 methods).

  // It's always a chain, and the only question is at each point what the resolution would be

  // Parallel hash inversions?
  // Can claim at any point (even with another open claim), but the first unmet claim is the only one paid
  // If verification fails AND hash inversion fails, pay to the first claimer
  // To resolve a hash claim,

  // Multiple verification claims are resolved in order of placement on the chain

  // How to incentivize rectification for verifier V?
  //   - Output to V, which forces a new block to be created.
  //     But this doesn't incentivize the new block to be used.
  //   + Blocks derived from an invalid block have a penalty equal to the rectification amount. But if it's too far back, and all available blocks have the same penalty, it doesn't really do anything. If a new chain is created that doesn't include the invalid block, it will likely be chosen.
  //     This is also nice because it penalizes building on an invalid block - not a lot, but your work is at risk of being discarded. So make sure you trust ancestors.

  // Jackpot. Easy. ClaimFailingVerifier after timeout.

  // public getCollateral(block: BlockExt): CollateralSummary {
  //   let ancestorOutputIdx: number | undefined;
  //   let postedAmountFor = 0n;
  //   let postedAmountAgainst = 0n;
  //   const ledger: {
  //     block: BlockExt;
  //     params: CollateralContractParams;
  //     amountDelta: bigint;
  //     outputIdx: number;
  //   }[] = [];
  //   let resolver: BlockExt | undefined;

  //   while (true) {
  //     const output = this.getCollateralOutput(block, ancestorOutputIdx);

  //     if (output === undefined) {
  //       resolver = block;
  //       break;
  //     }

  //     const amount = block.outputs[output.idx].amount;
  //     const amountDelta = amount - postedAmountFor - postedAmountAgainst;

  //     if (amountDelta <= 0n) {
  //       throw new Error(`Did not increase collateral!`);
  //     }

  //     if (output.params.valid) {
  //       // For
  //       postedAmountFor = amount - postedAmountAgainst;
  //     } else {
  //       // Against
  //       postedAmountAgainst = amount - postedAmountFor;
  //     }

  //     // if (side) {
  //     //   // Against
  //     //   amountAgainst = amount - amountFor;
  //     // } else {
  //     //   // For
  //     //   amountFor = amount - amountAgainst;
  //     // }

  //     // const canonicalClaim = block.outputClaims[idx].find((x) =>
  //     //   x.canonicality > 0
  //     // );
  //     // if (canonicalClaim) {
  //     //   return this.getFinalCollateral(
  //     //     canonicalClaim,
  //     //     idx,
  //     //     amountFor,
  //     //     amountAgainst,
  //     //   );
  //     // } else {
  //     //   return { block, amountFor, amountAgainst };
  //     // }

  //     ledger.push({
  //       block,
  //       params: output.params,
  //       amountDelta,
  //       outputIdx: output.idx,
  //     });

  //     const claims = block.outputClaims[output.idx];
  //     if (claims.length) {
  //       let maxCanonicality = -Infinity;
  //       for (const claim of claims) {
  //         if (claim.canonicality > maxCanonicality) {
  //           maxCanonicality = claim.canonicality;
  //           block = claim;
  //         }
  //       }

  //       if (block.timestamp >= output.params.free_after) {
  //         // TODO: Figure out how to enforce timestamp stuff
  //       }
  //     } else {
  //       break;
  //     }

  //     ancestorOutputIdx = output.idx;
  //   }

  //   if (ledger.length && !ledger[0].params.valid) {
  //     throw new Error(`Initial collateral posting is against!`);
  //   }
  //   const implicitAmountAgainst = ledger.length
  //     ? this.getImplicitClaimAgainst(ledger[0].amountDelta)
  //     : 0n;

  //   return {
  //     postedAmountFor,
  //     postedAmountAgainst,
  //     implicitAmountAgainst,
  //     ledger,
  //     resolver,
  //   };
  // }

  public getCollateral(block: BlockExt): CollateralSummary {
    const ledger =
      (this.collateralByBlockHash.get(block.hash.toPrimitive()) || []).sort(
        (a, b) => Number(a.block.timestamp - b.block.timestamp),
      );

    let postedAmountFor = 0n;
    let postedAmountAgainst = 0n;
    ledger.forEach((x) => {
      if (x.params.valid) {
        postedAmountFor += x.amountDelta;
      } else {
        postedAmountAgainst += x.amountDelta;
      }
    });
    let resolver: BlockExt | undefined;

    if (ledger.length && !ledger[0].params.valid) {
      throw new Error(`Initial collateral posting is against!`);
    }
    const implicitAmountAgainst = ledger.length
      ? this.getImplicitClaimAgainst(ledger[0].amountDelta)
      : 0n;

    return {
      postedAmountFor,
      postedAmountAgainst,
      implicitAmountAgainst,
      ledger,
      resolver,
    };
  }
  public updateCanonicality(block: BlockExt, someInputCanonicality?: boolean) {
    // Note that we consider missing inputs as canonical.
    // We also short-circuit if an input canonicality is false, which is a common case.

    const canonicality = block.inputs.reduce((acc, input) => {
      const claims = this.getClaims(input);
      const maxCompetitorWork = Math.max(
        ...claims.map((c) => c.block === block ? 0 : c.block.derivedWorkValue),
      );
      const delta = block.derivedWorkValue - maxCompetitorWork;
      const inputBlock = this.blocksByHash.get(input.block_hash.toPrimitive());
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
        for (const outputBlock of claims) {
          this.updateCanonicality(
            outputBlock,
            // outputBlock.derivedWorkValue === maxDerivedWork,
          );
        }
      }
    }

    for (const { block_hash } of block.inputs) {
      const input = this.blocksByHash.get(block_hash.toPrimitive());
      if (input !== undefined) {
        this.updateCollateral(input);
      }
    }
  }

  public updateCollateral(block: BlockExt) {
    block.collateral = block.outputs.reduce(
      (acc, { amount }, idx) =>
        amount > 0n
          ? Math.max(
            acc,
            Math.min(
              Number(amount),
              block.outputClaims[idx].reduce(
                (acc, claim) => Math.max(acc, claim.canonicality),
                0,
              ),
            ),
          )
          : acc,
      0,
    );
  }

  public updateDerivedWork(block: BlockExt) {
    let sum = Number(this.getWork(block));

    for (const claims of block.outputClaims) {
      for (const outputBlock of claims) {
        if (outputBlock.canonicality > 0) {
          sum += outputBlock.derivedWorkValue /
            outputBlock.inputs.filter(({ block_hash }) =>
              this.blocksByHash.get(block_hash.toPrimitive())
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
      .map(({ block_hash }) => this.blocksByHash.get(block_hash.toPrimitive()))
      .filter(Boolean);
    const errInc = err / knownInputs.length;
    for (const input of knownInputs) {
      input!.derivedWorkError += errInc;
      if (input!.derivedWorkError > input!.derivedWorkValue * 0.1) {
        this.updateDerivedWork(input!);
      }
    }

    for (const claims of block.outputClaims) {
      for (const outputBlock of claims) {
        this.updateLogMergeableProbability(outputBlock);
      }
    }

    this.updateCanonicality(block);
    this.updateLogMergeableProbability(block);
  }

  public updateLogMergeableProbability(block: BlockExt) {
    // Commented out because I think a canonicality bool is fine

    /*
    let sum = 0;
    for (const { block_hash, amount } of block.inputs) {
      const inBlock = this.blocksByHash.get(block_hash.toPrimitive());
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

  public getWork(block: Block | BlockSet) {
    return block.outputs.reduce((acc, { amount }) => acc + amount, 1n);
  }

  public getImplicitClaimAgainst(initialClaimFor: bigint) {
    return initialClaimFor > CHALLENGE_PRICE
      ? initialClaimFor - CHALLENGE_PRICE
      : 0n;
  }

  private getSamplesPerWork() {
    return 0.1;
  }

  private calculateMergeableProbability(block: BlockExt) {
    let prob = 1;
    for (const { block_hash, output_idx } of block.inputs) {
      const inBlock = this.blocksByHash.get(block_hash.toPrimitive());
      if (inBlock) {
        const claims = inBlock.outputClaims[output_idx];
        const total = claims.reduce((acc, cur) => acc + cur.derivedWork, 0);
        prob *= block.derivedWork / total;
      }
    }
    return prob;
  }

  private calculateDerivedWork(block: BlockExt) {
    let res = 0;
    for (const output of block.outputClaims) {
      for (const claim of output) {
        res += claim.derivedWork * claim.mergeableProbability;
      }
    }
    return res;
    // return BigInt(res) - BigInt(block.receivedTimestamp);
  }

  public get(hash: Hash) {
    // TODO: Incentivize network as well

    return this.blocksByHash.get(hash.toPrimitive());

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
    return [...this.blocksByHash.values()].filter((block) =>
      block.verifiers.some((v) =>
        Hash.equals(v.contract_hash, verifier.contract_hash) &&
        arrEquals(v.params, verifier.params)
      )
    );
  }

  public getBlocksByInput(input: BlockInput) {
    return [...this.blocksByHash.values()].filter((block) =>
      block.inputs.some((y) =>
        Hash.equals(y.block_hash, input.block_hash) &&
        y.output_idx === input.output_idx
      )
    );
  }

  public getBlocksByOutput(verifier: Verifier) {
    return [...this.blocksByHash.values()].flatMap((block) =>
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
    return [...this.blocksByHash.values()].flatMap((block) =>
      block.outputs.flatMap((y, idx) =>
        Hash.equals(y.verifier.contract_hash, contractHash) &&
          cond(y.verifier.params)
          ? [{ block, idx }]
          : []
      )
    );
  }

  public onNewBlock(verifier: Verifier, cb: (block: BlockExt) => void) {
    const verifierHash = Hash.digest(Verifier.encode(verifier));
    getOrCreate(this.onNewBlockListeners, verifierHash.toPrimitive(), () => [])
      .push(cb);
  }
  public offNewBlock(verifier: Verifier, cb: (block: BlockExt) => void) {
    const verifierHash = Hash.digest(Verifier.encode(verifier));
    const listeners = getOrCreate(
      this.onNewBlockListeners,
      verifierHash.toPrimitive(),
      () => [],
    );
    const idx = listeners.lastIndexOf(cb);
    if (idx === -1) {
      throw new Error(`Listener does not exist`);
    }
    listeners.splice(idx, 1);
  }

  public snapshot() {
    return { blocksByHash: this.blocksByHash };
  }
}

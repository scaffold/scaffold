import BlockBuilder from './BlockBuilder.ts';
import { accountHash, collateralHash } from './constants.ts';
import Context from './Context.ts';
import {
  BlockFact,
  BlockSetFact,
  Collateralization,
  FactType,
} from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import { AccountContractParams, BlockOutput } from './messages.ts';
import Hash, { EMPTY_HASH, HashPrimitive, ZERO_HASH } from './util/Hash.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { assert } from '~/sbl/util/functional.ts';
import {
  CollateralContractDetail,
  CollateralContractParams,
} from '~/sbl/collateralMessages.ts';
import BlockService from '~/sbl/BlockService.ts';
import ContractClassifierService from '~/sbl/ContractClassifierService.ts';
import { ValidationResult } from '~/sbl/BlockMeta.ts';
import { BurdenOfProof } from '~/sbl/WorkerLauncherService.ts';
import { bigint2bin } from '~/sbl/util/bigint.ts';

const resolutionDelay = 1000;

/*
2 claims:
This block is valid
This block is INVALID (very strong, unless uncanonical)
  Must be specific
*/

export default class LitigationService {
  private resolutionSchedules = new Map<HashPrimitive, number>();

  constructor(private ctx: Context) {}

  public litigate(
    block: BlockFact,
    hints: Uint8Array[],
    bops: BurdenOfProof[],
    result: boolean,
  ) {
    const amount = 1000n;

    if (amount <= 0n) {
      return;
    }

    this.ctx.get(BlockBuilder).publish({
      outputs: [{
        verifier: this.makeCollateralVerifier(block.hash),
        amount,
        detail: CollateralContractDetail.encode({
          public_key: this.ctx.get(KeyService).getSelfPublicKey(),
          hints,
          bop_bitmask: bigint2bin(bops.reduce(
            (acc, cur, idx) =>
              cur === BurdenOfProof.Validation ? (acc << 1n) | 1n : acc << 1n,
            0n,
          )),
          result,
        }),
      }],
    });
  }

  public litigateInput(
    block: BlockFact,
    inputIdx: number,
    result: CollateralContractDetail['result'],
    hint?: Uint8Array,
  ) {
    if (
      block.inputValidationResults[inputIdx] !== ValidationResult.Validating
    ) {
      throw new Error(
        `Unexpected validation result ${
          block.inputValidationResults[inputIdx]
        }`,
      );
    }

    switch (result) {
      case 'VALID':
        block.inputValidationResults[inputIdx] = ValidationResult.IsValid;
        break;
      case 'INVALID':
        block.inputValidationResults[inputIdx] = ValidationResult.IsInvalid;
        break;
      case 'INCONCLUSIVE':
        block.inputValidationResults[inputIdx] =
          ValidationResult.IsInconclusive;
        break;
      default:
        throw new Error(`Internal error`);
    }

    const amount = 1000n;

    if (amount <= 0n) {
      return;
    }
    this.ctx.get(BlockBuilder).publish({
      outputs: [{
        verifier: this.makeCollateralVerifier(block.hash),
        amount,
        detail: CollateralContractDetail.encode({
          public_key: this.ctx.get(KeyService).getSelfPublicKey(),
          contest: {
            CollateralContest: {
              target: { CollateralTargetVerifier: { input_idx: inputIdx } },
              hint: hint ? { bytes: hint } : null,
            },
          },
          result,
        }),
      }],
    });

    // const mask = 1n << BigInt(inputIdx);
    // if (valid) {
    //   if (block.validatedInputs & mask) {
    //     return;
    //   }
    //   block.validatedInputs |= mask;
    // } else {
    //   if (block.invalidatedInputs & mask) {
    //     return;
    //   }
    //   block.invalidatedInputs |= mask;
    // }

    // this.processInputValidity(block);
  }

  public processInputValidity(block: BlockFact) {
    // if (block.validatedInputs & block.invalidatedInputs) {
    //   throw new Error(`An input is both validated and invalidated!`);
    // }

    // if (block.validatedInputs === (1n << BigInt(block.inputs.length)) - 1n) {
    //   const claim = { ClaimAllValid: {} };
    //   this.litigateBlock(block, claim);
    // } else if (block.invalidatedInputs !== 0n) {
    //   const claim = { ClaimVerificationFailed: { input_idx: inputIdx, hint } };
    //   this.litigateBlock(block, claim);
    // }
  }

  private makeCollateralVerifier(blockHash: Hash) {
    return {
      contract_hash: collateralHash,
      params: CollateralContractParams.encode({ block_hash: blockHash }),
    };
  }

  public litigateBlock(
    fact: BlockFact,
    claim: CollateralContractDetail['contest'],
    result: CollateralContractDetail['result'],
  ) {
  }

  /*
  public litigateBlock(fact: BlockFact, claim: CollateralContest) {
    let amount: bigint;

    if ('ClaimAllValid' in claim) {
      if (fact.claimedWork === undefined) {
        throw new Error(
          `Cannot claim all valid without full knowledge of block!`,
        );
      }
      amount = this.ctx.config.graphParameters.minimumCollateral(
        fact.claimedWork,
        this.ctx.config.timeProvider.now(),
      );
    } else if (
      'ClaimRequestInputHash' in claim && fact.type === FactType.Block
    ) {
      const { input_idx } = claim.ClaimRequestInputHash;

      let pro = 0n;
      let con = 0n;
      for (const coll of fact.collateralizations) {
        if (
          'ClaimRequestInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimRequestInputHash.input_idx === input_idx
        ) {
          con += coll.amount;
        } else if (
          'ClaimReplyInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimReplyInputHash.input_idx === input_idx
        ) {
          pro += coll.amount;
        }
      }

      // Post AGAINST
      amount = (pro << 1n) - con;
    } else if ('ClaimReplyInputHash' in claim && fact.type === FactType.Block) {
      const { input_idx, hint } = claim.ClaimReplyInputHash;

      const hintHash = Hash.digest(hint);
      if (!Hash.equals(hintHash, fact.inputs[input_idx].block_hash)) {
        console.error(`You're voting for an incorrect input hash!`);
      }

      let pro = 0n;
      let con = 0n;
      for (const coll of fact.collateralizations) {
        if (
          'ClaimRequestInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimRequestInputHash.input_idx === input_idx
        ) {
          con += coll.amount;
        } else if (
          'ClaimReplyInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimReplyInputHash.input_idx === input_idx
        ) {
          pro += coll.amount;
        }
      }

      // Post FOR
      amount = (con << 1n) - pro;
    } else if (
      'ClaimVerificationFailed' in claim && fact.type === FactType.Block
    ) {
      const { input_idx, hint } = claim.ClaimVerificationFailed;

      let pro = 0n;
      let con = 0n;
      for (const coll of fact.collateralizations) {
        if (
          'ClaimVerificationFailed' in coll.detail.claim &&
          coll.detail.claim.ClaimVerificationFailed.input_idx === input_idx &&
          arrEquals(coll.detail.claim.ClaimVerificationFailed.hint, hint)
        ) {
          con += coll.amount;
        } else if (
          'ClaimVerificationPassed' in coll.detail.claim &&
          coll.detail.claim.ClaimVerificationPassed.input_idx === input_idx &&
          arrEquals(coll.detail.claim.ClaimVerificationPassed.hint, hint)
        ) {
          pro += coll.amount;
        }
      }

      // Post AGAINST
      amount = (pro << 1n) - con;
    } else if (
      'ClaimVerificationPassed' in claim && fact.type === FactType.Block
    ) {
      const { input_idx, hint } = claim.ClaimVerificationPassed;

      let pro = 0n;
      let con = 0n;
      for (const coll of fact.collateralizations) {
        if (
          'ClaimVerificationFailed' in coll.detail.claim &&
          coll.detail.claim.ClaimVerificationFailed.input_idx === input_idx &&
          arrEquals(coll.detail.claim.ClaimVerificationFailed.hint, hint)
        ) {
          con += coll.amount;
        } else if (
          'ClaimVerificationPassed' in coll.detail.claim &&
          coll.detail.claim.ClaimVerificationPassed.input_idx === input_idx &&
          arrEquals(coll.detail.claim.ClaimVerificationPassed.hint, hint)
        ) {
          pro += coll.amount;
        }
      }

      // Post FOR
      amount = (con << 1n) - pro;
    } else {
      throw new Error(`Invalid claim`);
    }

    if (amount <= 0n) {
      return;
    }

    this.ctx.get(BlockBuilder).publish({
      outputs: [{
        verifier: this.makeCollateralVerifier(fact.hash),
        amount,
        detail: CollateralContractDetail.encode({
          public_key: this.ctx.get(KeyService).getSelfPublicKey(),
          claim,
        }),
      }],
    });
  }

  public scheduleResolution(block: BlockFact) {
    // TODO: Make sure scheduling works the same using CollateralContract

    const pub = () => {
      assert(this.resolutionSchedules.delete(block.hash.toPrimitive()));
      this.publishResolution(block);
    };
    getOrCreate(
      this.resolutionSchedules,
      block.hash.toPrimitive(),
      () => this.ctx.config.timeProvider.setTimeout(pub, resolutionDelay),
      (timeout) => {
        this.ctx.config.timeProvider.clearTimeout(timeout);
        return this.ctx.config.timeProvider.setTimeout(pub, resolutionDelay);
      },
    );
  }

  private publishResolution(fact: BlockFact | BlockSetFact) {
    // const frontierVote = this.ctx.get(FrontierService)
    //   .getBlockVote(fact.collateralizations);
    // if (frontierVote === undefined) {
    //   console.warn(
    //     `Can't create a litigation resolution because we don't have a frontier!`,
    //   );
    //   return;
    // }
    const frontierVote = undefined;

    // this.ctx.get(BlockService).sort(fact.collateralizations, frontierVote);

    interface Stack {
      totalPros: bigint;
      totalCons: bigint;
      pros: Collateralization[];
      cons: Collateralization[];
    }

    let validScore = 0n;
    const allValids: Collateralization[] = [];
    const hashScores = new Map<number, Stack>();
    const verificationScores = new Map<HashPrimitive, Stack>();

    // Distribute coins amongst each hint stack. Distribute all valid coins amongst winners of first invalidator

    for (const coll of fact.collateralizations) {
      const { detail, amount } = coll;

      const addPro = <Key>(map: Map<Key, Stack>, key: Key) =>
        getOrCreate(
          map,
          key,
          () => ({ totalPros: amount, totalCons: 0n, pros: [coll], cons: [] }),
          (stack) => {
            stack.totalPros += amount;
            stack.pros.push(coll);
            return stack;
          },
        );
      const addCon = <Key>(map: Map<Key, Stack>, key: Key) =>
        getOrCreate(
          map,
          key,
          () => ({ totalPros: 0n, totalCons: amount, pros: [], cons: [coll] }),
          (stack) => {
            stack.totalCons += amount;
            stack.cons.push(coll);
            return stack;
          },
        );

      if ('ClaimAllValid' in detail.claim) {
        validScore += amount;
        allValids.push(coll);
      } else if (
        'ClaimRequestInputHash' in detail.claim && fact.type === FactType.Block
      ) {
        const { input_idx } = detail.claim.ClaimRequestInputHash;
        addCon(hashScores, input_idx);
      } else if (
        'ClaimReplyInputHash' in detail.claim && fact.type === FactType.Block
      ) {
        const { input_idx, hint } = detail.claim.ClaimReplyInputHash;
        const hintHash = Hash.digest(hint);
        if (!Hash.equals(hintHash, fact.inputs[input_idx].block_hash)) {
          console.error(`Someone's voting for an incorrect input hash!`);
        }
        addPro(hashScores, input_idx);
      } else if (
        'ClaimVerificationFailed' in detail.claim &&
        fact.type === FactType.Block
      ) {
        const { input_idx, hint } = detail.claim.ClaimVerificationFailed;
        const pt = Hash.digestParts(input_idx, hint);
        addCon(verificationScores, pt.toPrimitive());
      } else if (
        'ClaimVerificationPassed' in detail.claim &&
        fact.type === FactType.Block
      ) {
        const { input_idx, hint } = detail.claim.ClaimVerificationPassed;
        const pt = Hash.digestParts(input_idx, hint);
        addPro(verificationScores, pt.toPrimitive());
      } else {
        throw new Error(`Invalid claim`);
      }
    }

    const outputs: BlockOutput[] = [];
    let firstInvalid: Stack | undefined;

    const distributeCoins = (stack: Stack) => {
      if (stack.totalCons > stack.totalPros) {
        // Invalid

        let src = firstInvalid === undefined
          ? stack.totalPros + validScore
          : stack.totalPros;
        let dst = stack.totalCons;

        for (const coll of stack.cons) {
          const amount = coll.amount * src / dst;
          src -= amount;
          dst -= coll.amount;
          outputs.push({
            verifier: {
              contract_hash: accountHash,
              params: AccountContractParams.encode({
                public_key: coll.detail.public_key,
              }),
            },
            amount,
            detail: new Uint8Array(),
          });
        }

        firstInvalid = stack;
      } else {
        // Valid

        let src = stack.totalCons;
        let dst = stack.totalPros;

        for (const coll of stack.pros) {
          const amount = coll.amount * src / dst;
          src -= amount;
          dst -= coll.amount;
          outputs.push({
            verifier: {
              contract_hash: accountHash,
              params: AccountContractParams.encode({
                public_key: coll.detail.public_key,
              }),
            },
            amount,
            detail: new Uint8Array(),
          });
        }
      }
    };

    for (const [_, stack] of hashScores) {
      distributeCoins(stack);
    }
    for (const [_, stack] of verificationScores) {
      distributeCoins(stack);
    }

    if (firstInvalid === undefined) {
      // Valid

      for (const coll of allValids) {
        outputs.push({
          verifier: {
            contract_hash: accountHash,
            params: AccountContractParams.encode({
              public_key: coll.detail.public_key,
            }),
          },
          amount: coll.amount,
          detail: new Uint8Array(),
        });
      }
    }

    const inputTotal = fact.collateralizations.reduce(
      (acc, cur) => acc + cur.amount,
      0n,
    );
    const outputTotal = outputs.reduce((acc, cur) => acc + cur.amount, 0n);
    if (inputTotal !== outputTotal) {
      throw new Error(
        `Trying to publish a resolution but the input total ${inputTotal} does not match the output total ${outputTotal}`,
      );
    }

    this.ctx.get(BlockBuilder).publish({
      inputs: fact.collateralizations,
      outputs,
      frontierVote,
    });
  }
  */

  // public makeHintInput(block: BlockFact) {
  //   const hintOutput = {
  //     amount: 1n,
  //     verifier: { contract_hash: hintHash, params: new Uint8Array([]) },
  //   };

  //   const collateralBlock = this.ctx.get(BlockBuilder).emit({
  //     outputs: [hintOutput],
  //   }, []);

  //   return {
  //     block_hash: this.ctx.get(BlockService).create(collateralBlock),
  //     output_idx: 0,
  //     amount: 1n,
  //   };
  // }
}

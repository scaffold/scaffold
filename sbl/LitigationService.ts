import BlockBuilder from './BlockBuilder.ts';
import BlockService from './BlockService.ts';
import {
  accountHash,
  collateralHash,
  epochInclusionHash,
  hintHash,
} from './constants.ts';
import Context from './Context.ts';
import { BlockFact, Collateralization } from '~/sbl/FactMeta.ts';
import KeyService from './KeyService.ts';
import {
  AccountContractParams,
  BlockInput,
  BlockOutput,
  CollateralContractDetail,
  CollateralContractParams,
  EpochInclusionParams,
} from './messages.ts';
import Hash, { EMPTY_HASH, HashPrimitive } from './util/Hash.ts';
import FactService from '~/sbl/FactService.ts';
import FrontierMonitorService from '~/sbl/FrontierMonitorService.ts';
import CollateralContract from '~/sbl/CollateralContract.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import FrontierService from '~/sbl/FrontierService.ts';
import { bin2hex } from '~/sbl/pathUtils.ts';
import { arrEquals } from '~/sbl/util/buffer.ts';
import { assert } from '~/sbl/util/functional.ts';

const resolutionDelay = 1000;

export default class LitigationService {
  private resolutionSchedules = new Map<HashPrimitive, number>();

  constructor(private ctx: Context) {}

  public litigateBlock(
    block: BlockFact,
    claim: CollateralContractDetail['claim'],
  ) {
    let amount: bigint;

    if ('ClaimAllValid' in claim) {
      if (block.claimedWork === undefined) {
        throw new Error(`Cannot claim a block is valid without all inputs!`);
      }

      amount = this.ctx.config.graphParameters.minimumCollateral(
        block.claimedWork,
        this.ctx.config.timeProvider.now(),
      );
    } else if ('ClaimMissingInputHash' in claim) {
      const { input_idx } = claim.ClaimMissingInputHash;

      let pro = 0n;
      let con = 0n;
      for (const coll of block.collateralizations) {
        if (
          'ClaimMissingInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimMissingInputHash.input_idx === input_idx
        ) {
          con += coll.amount;
        } else if (
          'ClaimHasInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimHasInputHash.input_idx === input_idx
        ) {
          pro += coll.amount;
        }
      }

      // Post AGAINST
      amount = (pro << 1n) - con;
    } else if ('ClaimHasInputHash' in claim) {
      const { input_idx, hint } = claim.ClaimHasInputHash;

      const hintHash = Hash.digest(hint);
      if (!Hash.equals(hintHash, block.inputs[input_idx].block_hash)) {
        console.error(`You're voting for an incorrect input hash!`);
      }

      let pro = 0n;
      let con = 0n;
      for (const coll of block.collateralizations) {
        if (
          'ClaimMissingInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimMissingInputHash.input_idx === input_idx
        ) {
          con += coll.amount;
        } else if (
          'ClaimHasInputHash' in coll.detail.claim &&
          coll.detail.claim.ClaimHasInputHash.input_idx === input_idx
        ) {
          pro += coll.amount;
        }
      }

      // Post FOR
      amount = (con << 1n) - pro;
    } else if ('ClaimVerificationFailed' in claim) {
      const { input_idx, hint } = claim.ClaimVerificationFailed;

      let pro = 0n;
      let con = 0n;
      for (const coll of block.collateralizations) {
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
    } else if ('ClaimVerificationPassed' in claim) {
      const { input_idx, hint } = claim.ClaimVerificationPassed;

      let pro = 0n;
      let con = 0n;
      for (const coll of block.collateralizations) {
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
        verifier: {
          contract_hash: collateralHash,
          params: CollateralContractParams.encode({ block_hash: block.hash }),
        },
        amount,
        detail: CollateralContractDetail.encode({
          public_key: this.ctx.get(KeyService).getSelfPublicKey(),
          claim,
        }),
      }],
    });
  }

  public scheduleResolution(block: BlockFact) {
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

  private publishResolution(block: BlockFact) {
    const frontierVote = this.ctx.get(FrontierService)
      .getBlockVote(block.collateralizations);
    if (frontierVote === undefined) {
      console.warn(
        `Can't create a litigation resolution because we don't have a frontier!`,
      );
      return;
    }

    this.ctx.get(BlockService).sort(block.collateralizations, frontierVote);

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

    for (const coll of block.collateralizations) {
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
      } else if ('ClaimMissingInputHash' in detail.claim) {
        const { input_idx } = detail.claim.ClaimMissingInputHash;
        addCon(hashScores, input_idx);
      } else if ('ClaimHasInputHash' in detail.claim) {
        const { input_idx, hint } = detail.claim.ClaimHasInputHash;
        const hintHash = Hash.digest(hint);
        if (!Hash.equals(hintHash, block.inputs[input_idx].block_hash)) {
          console.error(`Someone's voting for an incorrect input hash!`);
        }
        addPro(hashScores, input_idx);
      } else if ('ClaimVerificationFailed' in detail.claim) {
        const { input_idx, hint } = detail.claim.ClaimVerificationFailed;
        const pt = Hash.digestParts(input_idx, hint);
        addCon(verificationScores, pt.toPrimitive());
      } else if ('ClaimVerificationPassed' in detail.claim) {
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

    const inputTotal = block.collateralizations.reduce(
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
      inputs: block.collateralizations,
      outputs,
      frontierVote,
    });
  }

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

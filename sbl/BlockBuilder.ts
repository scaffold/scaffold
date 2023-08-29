import Hash from './util/Hash.ts';
import Context from './Context.ts';
import {
  AccountContractParams,
  Block,
  BlockInput,
  BlockOutput,
  Verifier,
} from './messages.ts';
import IncentiveService from './IncentiveService.ts';
// import IncentiveCalculator from './IncentiveCalculator.ts';
import BlockService from './BlockService.ts';
import { arrEquals } from './util/buffer.ts';
import { accountHash, epochHash, trueHash } from './constants.ts';
import KeyService from './KeyService.ts';
import Logger from './Logger.ts';
import BlockSetService from '~/sbl/BlockSetService.ts';
import FrontierService from '~/sbl/FrontierService.ts';

export default class BlockBuilder {
  private selfAccountVerifier: Verifier;

  constructor(private ctx: Context) {
    this.selfAccountVerifier = {
      contract_hash: accountHash,
      params: AccountContractParams.encode({
        public_key: this.ctx.get(KeyService).getSelfPublicKey(),
      }),
    };
  }

  public emit(
    block: {
      body?: Uint8Array;
      inputs?: (BlockInput & { amount: bigint })[];
      outputs?: BlockOutput[];
    },
    satisfies: Verifier[],
    timeout = 0,
  ): Block {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

    let difference = 0n;

    // const verifier_hash = Hash.digest(Verifier.encode(verifier));
    // const inputs = this.ctx.get(IncentiveRegistry).pop(verifier_hash)?.inputs ||
    //   [];
    const inputs = block.inputs ?? [];
    for (const v of satisfies) {
      let added = false;
      for (
        const { block, idx } of this.ctx.get(BlockService).getBlocksByOutput(v)
      ) {
        if (
          block.outputClaims[idx].length === 0 &&
          block.outputs[idx].amount >= 0n
        ) {
          inputs.push({
            block_hash: block.hash,
            output_idx: idx,
            amount: block.outputs[idx].amount,
          });
          added = true;

          if (
            Hash.equals(block.outputs[idx].verifier.contract_hash, epochHash)
          ) {
            difference += 1000000n;
          }
        }
      }

      if (!added) {
        const block = this.emit({
          outputs: [{ verifier: v, amount: 0n }],
        }, []);
        inputs.push({
          block_hash: this.ctx.get(BlockService).create(block).hash,
          output_idx: 0,
          amount: 0n,
        });
      }
    }

    const outputs = block.outputs ?? [];
    difference += inputs.reduce((acc, cur) => acc + cur.amount, 0n);
    difference -= outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    if (difference < 0n) {
      const accountInputs = this.ctx.get(BlockService).getBlocksByOutput(
        this.selfAccountVerifier,
      );
      for (const { block, idx } of accountInputs) {
        const amount = block.outputs[idx].amount;
        if (amount > 0n) {
          inputs.push({
            block_hash: block.hash,
            output_idx: idx,
            amount,
          });
          difference += amount;
          if (difference >= 0n) {
            break;
          }
        }
      }
    }

    if (difference > 0n) {
      outputs.push({ verifier: this.selfAccountVerifier, amount: difference });
    } else if (difference < 0n) {
      // TODO: Only output what we actually have
      throw new Error('INSUFFICIENT_COINS');
    }

    const frontier = this.ctx.get(FrontierService).getBlockVote(inputs);

    // TODO: Can bundle multiple blocks without bodies
    const body = block.body ?? new Uint8Array([]);

    const isFreeMarket = true;
    let timestamp = BigInt(this.ctx.config.timeProvider.now());
    inputs.forEach((input) => {
      // TODO: No need to look these blocks up; just store them in IncentiveRegistry
      const inputTs =
        this.ctx.get(BlockService).get(input.block_hash)!.timestamp;
      if (inputTs >= timestamp) {
        // timestamp = inputTs + 1n;
        timestamp = inputTs;
      }
    });

    return {
      inputs,
      outputs,
      frontier,
      body,
      is_free_market: isFreeMarket,
      timestamp,
    };
  }
}

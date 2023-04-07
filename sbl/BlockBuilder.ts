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
import { accountHash, trueHash } from './constants.ts';
import KeyService from './KeyService.ts';
import Logger from './Logger.ts';

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

  public async emit(
    block: {
      body?: Uint8Array;
      inputs?: (BlockInput & { amount: bigint })[];
      outputs?: BlockOutput[];
    },
    satisfies: Verifier[],
    timeout = 0,
  ): Promise<Block> {
    // 1. Gather all satisfying (positive?) inputs that someone else could claim (which doesn't include signature satisfaction).
    // 2. For remaining output value, input to/from account balance (signature satisfaction).

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
        }
      }

      if (!added) {
        const block = await this.emit({
          outputs: [{ verifier: v, amount: 0n }],
        }, []);
        const hash = await this.ctx.get(BlockService).create(block);
        inputs.push({ block_hash: hash, output_idx: 0, amount: 0n });
      }
    }

    const outputs = block.outputs ?? [];
    let difference = inputs.reduce((acc, cur) => acc + cur.amount, 0n) -
      outputs.reduce((acc, cur) => acc + cur.amount, 0n);

    if (difference < 0n) {
      const accountInputs = this.ctx.get(BlockService).getBlocksByOutput(
        this.selfAccountVerifier,
      );
      for (const { block, idx } of accountInputs) {
        const amount = block.outputs[idx].amount;
        if (amount > 0n) {
          inputs.push({ block_hash: block.hash, output_idx: idx, amount });
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
      outputs.push({
        verifier: { contract_hash: trueHash, params: new Uint8Array([]) },
        amount: difference,
      });
    }

    // TODO: Can bundle multiple blocks without bodies
    const body = block.body ?? new Uint8Array([]);

    const side = true;
    const isFreeMarket = true;
    let timestamp = BigInt(Date.now());
    inputs.forEach((input) => {
      // TODO: No need to look these blocks up; just store them in IncentiveRegistry
      const inputTs =
        this.ctx.get(BlockService).get(input.block_hash)!.timestamp;
      if (inputTs >= timestamp) {
        timestamp = inputTs + 1n;
      }
    });

    return { inputs, outputs, body, side, isFreeMarket, timestamp };
  }
}

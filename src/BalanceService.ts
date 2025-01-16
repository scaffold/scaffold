import { Context } from './Context.ts';
import { KeyService } from './KeyService.ts';
import { BlockService } from './BlockService.ts';
import { accountHash } from './hashes.ts';
import { AccountContractParams, BlockOutput } from './messages.ts';
import { WeightService } from './WeightService.ts';
import { GenesisService } from './GenesisService.ts';
import { Hash } from './util/Hash.ts';

export class BalanceService {
  constructor(private ctx: Context) {}

  public getLiquidBalance(
    publicKey = this.ctx.get(KeyService).getSelfPublicKey(),
  ) {
    const verifier = {
      contractHash: accountHash,
      params: AccountContractParams.encode({ publicKey }),
    };

    const genesis = this.ctx.get(GenesisService).getGenesisBlock();
    const leaves = this.ctx.get(WeightService).getDescendant(genesis).leaves;
    // TODO: Use all leaves
    const base = leaves[leaves.length - 1];
    const outputs: { blockHash: Hash; amount: bigint }[] = base !== undefined ? [] : [];

    let amount = 0n;
    for (const output of outputs) {
      const block = this.ctx.get(BlockService).get(output.blockHash, false);
      if (
        block !== undefined && this.ctx.get(WeightService).isCanonical(block)
      ) {
        amount += output.amount;
      }
    }
    return amount;
  }
}

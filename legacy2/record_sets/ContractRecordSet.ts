import { Context } from '../Context.ts';
import { BlockFact, Fact, FactRef, FactType } from '../FactMeta.ts';
import { ReactiveRecordSet } from './ReactiveRecordSet.ts';
import { FactService } from '../FactService.ts';
import { ContractProvider } from '../SpecialContractManager.ts';
import { Hash, HashPrimitive } from '../util/Hash.ts';
import { setPut } from '../util/set.ts';

export interface ContractSpec {
  hash: Hash;
  provider?: ContractProvider;
}

export class ContractRecordSet extends ReactiveRecordSet<ContractSpec> {
  private emittedHashes = new Set<HashPrimitive>();

  constructor(ctx: Context) {
    super(ctx);
  }

  public *getAll(): Iterable<ContractSpec> {
    for (const provider of this.ctx.config.contractProviders) {
      if (setPut(this.emittedHashes, provider.contractHash.toPrimitive())) {
        yield { hash: provider.contractHash, provider };
      }
    }

    for (const fact of this.ctx.get(FactService).getAll()) {
      if (fact.type === FactType.Block) {
        for (const output of fact.outputs) {
          if (setPut(this.emittedHashes, output.verifier.contractHash.toPrimitive())) {
            yield { hash: output.verifier.contractHash };
          }
        }
      }
    }
  }

  public ingestBlock(block: BlockFact) {
    for (const output of block.outputs) {
      if (setPut(this.emittedHashes, output.verifier.contractHash.toPrimitive())) {
        this.dispatchAdd({ hash: output.verifier.contractHash });
      }
    }
  }
}

import Context from '~/sbl/Context.ts';
import { AccountContractParams, Verifier } from '~/sbl/messages.ts';
import { neverPromise } from '~/sbl/util/functional.ts';
import { ResolvingMonitor } from '~/sbl/util/Monitor.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { InputSpec } from '~/sbl/BlockBuilder.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { getOrCreate } from '~/sbl/util/map.ts';
import WeightService from '~/sbl/WeightService.ts';

export default class UnclaimedOutputService {
  private unclaimedOutputs = new Map<HashPrimitive, InputSpec[]>();
  private monitor = new ResolvingMonitor<InputSpec, Hash>((h) => h);

  constructor(private ctx: Context) {
    throw new Error(`Do not construct me!`);
  }

  public claim(
    verifier: Verifier,
    cancelSignal: AbortSignal,
    filter?: (spec: InputSpec) => boolean,
  ) {
    if (cancelSignal.aborted) {
      return neverPromise;
    }

    while (true) {
      const now = this.claimNow(verifier, filter);
      if (now === undefined) {
        break;
      } else if (this.ctx.get(WeightService).isCanonical(now.block)) {
        return now;
      }
    }

    const key = Hash.digest(Verifier.encode(verifier));
    return this.monitor.waitFor(key, cancelSignal, filter);
  }

  public claimNow(verifier: Verifier, filter?: (spec: InputSpec) => boolean) {
    const key = Hash.digest(Verifier.encode(verifier));
    const found = this.unclaimedOutputs.get(key.toPrimitive());
    if (found) {
      for (let i = 0; i < found.length; i++) {
        if (filter === undefined || filter(found[i])) {
          if (found.length === 1) {
            this.unclaimedOutputs.delete(key.toPrimitive());
            return found[0];
          } else {
            return found.splice(i, 1)[0];
          }
        }
      }
    }
  }

  public addUnclaimed(block: BlockFact, outputIdx: number) {
    if (this.ctx.get(WeightService).isCanonical(block)) {
      const { verifier, amount } = block.outputs[outputIdx];
      const spec = { block, outputIdx, amount };
      const key = Hash.digest(Verifier.encode(verifier));
      if (!this.monitor.resolveOne(key, spec)) {
        getOrCreate(this.unclaimedOutputs, key.toPrimitive(), () => [])
          .push(spec);
      }
    }
  }

  public removeUnclaimed(block: BlockFact, outputIdx: number) {
    const { verifier } = block.outputs[outputIdx];
    const key = Hash.digest(Verifier.encode(verifier));

    const specs = this.unclaimedOutputs.get(key.toPrimitive());
    if (specs === undefined) {
      // TODO: Throw an error here
      return;

      // throw new Error(`Cannot remove unclaimed; it's not there`);
    }

    const foundIdx = specs.findIndex((spec) =>
      spec.block === block && spec.outputIdx === outputIdx
    );
    if (foundIdx === -1) {
      // TODO: Throw an error here
      return;

      // throw new Error(`Cannot remove unclaimed; it's not there`);
    }

    if (specs.length === 1) {
      this.unclaimedOutputs.delete(key.toPrimitive());
    } else {
      specs.splice(foundIdx, 1);
    }
  }
}

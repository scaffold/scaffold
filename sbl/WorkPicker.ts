import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { GeneratorRegistry, IncentiveRegistry } from './registries.ts';

export default class WorkPicker {
  constructor(private ctx: Context) {}

  public pick(exclude: Hash[]) {
    const candidates = this.ctx.get(IncentiveRegistry).getAll()
      .map(({ key, val }) => ({
        key,
        amount: val.claims.reduce((acc, claim) => acc + claim.amount, 0n),
        generator: this.ctx.get(GeneratorRegistry).get(
          val.verifier.contract_hash,
        ),
        params: val.verifier.params,
      }))
      .filter((a) =>
        a.generator && !exclude.some((hash) => Hash.equals(hash, a.key))
      )
      .sort((a, b) => a.amount > b.amount ? 1 : a.amount < b.amount ? -1 : 0);

    if (candidates.length) {
      const cd = candidates[0];
      return {
        key: cd.key,
        generator: cd.generator![0].body,
        params: cd.params,
      };
    }
  }
}

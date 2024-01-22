import Context from './Context.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { BlockFact, FactType } from './FactMeta.ts';
import { CollateralHint } from './collateralMessages.ts';
import FactService from './FactService.ts';
import { mapPut } from './util/map.ts';

export interface HintProvider {
  suggestNext(params: Uint8Array, hints: Uint8Array[]): Uint8Array[];
}

export default class HintSuggestionService {
  private providers = new Map<HashPrimitive, HintProvider[]>();

  constructor(private ctx: Context) {}

  public registerSuggestor(contractHash: Hash, provider: HintProvider) {
    mapPut(this.providers, contractHash.toPrimitive(), () => []).push(provider);
  }

  public suggest(block: BlockFact, hints: Uint8Array[]): Uint8Array[] {
    if (hints.length === 0) {
      return [
        ...Array.from(
          { length: block.inputs.length },
          (_, i) =>
            CollateralHint.encode({
              hint: { CollateralHintInputHash: { inputIdx: i } },
            }),
        ),
        ...Array.from(
          { length: block.bodies.length },
          (_, i) =>
            CollateralHint.encode({
              hint: { CollateralHintVerifier: { groupIdx: i } },
            }),
        ),
      ];
    }

    const [first, ...rest] = hints;

    const { hint } = CollateralHint.decode(first);
    if ('CollateralHintInputHash' in hint) {
      if (rest.length === 0) {
        const input = block.inputs[hint.CollateralHintInputHash.inputIdx];
        const inBlock = this.ctx.get(FactService).get(input.blockHash, false);
        return inBlock !== undefined ? [inBlock.data] : [];
      } else {
        throw new Error(`Invalid request!`);
      }
    } else if ('CollateralHintVerifier' in hint) {
      const verifier = block.verifiers[hint.CollateralHintVerifier.groupIdx];
      if (verifier === undefined) {
        return [];
      }
      return (this.providers.get(verifier.contract_hash.toPrimitive()) ?? [])
        .flatMap((provider) => provider.suggestNext(verifier.params, rest));
    } else {
      throw new Error(`Invalid top-level hint!`);
    }
  }
}

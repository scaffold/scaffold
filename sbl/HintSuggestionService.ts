import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import { BlockFact, FactType } from '~/sbl/FactMeta.ts';
import { CollateralHint } from '~/sbl/collateralMessages.ts';
import FactService from '~/sbl/FactService.ts';
import { Verifier } from '~/sbl/messages.ts';
import { mapPut } from '~/sbl/util/map.ts';

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
      return Array.from(
        { length: block.inputs.length << 1 },
        (_, i) =>
          i & 1
            ? CollateralHint.encode({
              hint: { CollateralHintVerifier: { input_idx: i >>> 1 } },
            })
            : CollateralHint.encode({
              hint: { CollateralHintInputHash: { input_idx: i >>> 1 } },
            }),
      );
    }

    const [first, ...rest] = hints;

    let verifier: Verifier;
    const { hint } = CollateralHint.decode(first);
    if ('CollateralHintInputHash' in hint) {
      if (rest.length === 0) {
        const input = block.inputs[hint.CollateralHintInputHash.input_idx];
        const inBlock = this.ctx.get(FactService).get(input.block_hash, false);
        return inBlock !== undefined ? [inBlock.data] : [];
      } else {
        throw new Error(`Invalid request!`);
      }
    } else if ('CollateralHintVerifier' in hint) {
      const input = block.inputs[hint.CollateralHintVerifier.input_idx];
      const inBlock = this.ctx.get(FactService).get(input.block_hash, false);
      if (inBlock === undefined) {
        return [];
      }
      if (inBlock.type !== FactType.Block) {
        throw new Error(`Invalid fact type!`);
      }
      verifier = inBlock.outputs[input.output_idx].verifier;
    } else {
      throw new Error(`Decoding error!`);
    }

    return (this.providers.get(verifier.contract_hash.toPrimitive()) ?? [])
      .flatMap((provider) => provider.suggestNext(verifier.params, rest));
  }
}

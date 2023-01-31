import Context from './Context.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';

export type LocalGenerator = (
  opts: {
    ctx: Context;
    contractHash: Hash;
    params: Uint8Array;
    emitCorrect: boolean;
    setFreeMarket: () => void; // TODO: Remove this when we have remote generators
    request: (contractHash: Hash, params: Uint8Array) => Uint8Array;
    notify: (contractHash: Hash, params: Uint8Array) => void;
  },
) => Uint8Array | Promise<Uint8Array>;

export default class LocalGeneratorService {
  private registry: Map<HashPrimitive, LocalGenerator> = new Map();

  constructor(private ctx: Context) {}

  public addGenerator(contract: Hash, generator: LocalGenerator) {
    getOrCreate(
      this.registry,
      contract.toPrimitive(),
      () => generator,
      (_gen) => {
        throw new Error(
          `Cannot add multiple local generators for contract ${contract.toHex()}`,
        );
      },
    );
  }

  public getGenerator(contract: Hash) {
    return this.registry.get(contract.toPrimitive());
  }
}

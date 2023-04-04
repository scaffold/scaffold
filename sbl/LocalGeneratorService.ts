import Context from './Context.ts';
import { BlockInput, BlockOutput } from './messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { MaybePromise } from './util/types.ts';

export const ANY_BODY_FLAG = Symbol('LocalGenerator.AnyBody'); // TODO: Make this just void?
export const INGENERABLE_FLAG = Symbol('LocalGenerator.Ingenerable');

export interface LocalGeneratorOpts {
  ctx: Context;
  contractHash: Hash;
  params: Uint8Array;
  inputIdx: number;
  emitCorrect: boolean;
  setFreeMarket(): void; // TODO: Remove this when we have remote generators
  setBody(body: Uint8Array): void;
  // addInput(input: BlockInput): number; // TODO: I don't know if this makes sense
  addOutput(output: BlockOutput): number;
  sign(): void;
  invert(hash: Hash): MaybePromise<Uint8Array>;
  request(
    contractHash: Hash,
    params: Uint8Array,
  ): MaybePromise<Uint8Array>;
  notify(contractHash: Hash, params: Uint8Array): void;
}

export type LocalGenerator = (
  opts: LocalGeneratorOpts,
) => MaybePromise<typeof ANY_BODY_FLAG | typeof INGENERABLE_FLAG | Uint8Array>;
// TODO: Return a partial block that can be fed to BlockBuilder?

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

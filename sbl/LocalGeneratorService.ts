import Context from './Context.ts';
import { BlockFact } from '~/sbl/FactMeta.ts';
import { BlockInput, BlockOutput } from './messages.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import { getOrCreate } from './util/map.ts';
import { MaybePromise } from './util/types.ts';
import { ExecutorDriver } from './ExecutorDriverService.ts';

export const ANY_BODY_FLAG = Symbol('LocalGenerator.AnyBody'); // TODO: Make this just void?
export const INGENERABLE_FLAG = Symbol('LocalGenerator.Ingenerable');

export interface LocalGeneratorOpts {
  ctx: Context;
  driver: ExecutorDriver;
  contractHash: Hash;
  params: Uint8Array;
  details: Uint8Array[];
  inputIdx: number;
  emitCorrect: boolean;
  setFreeMarket(): void; // TODO: Remove this when we have remote generators
  setBody(body: Uint8Array): void;
  // addInput(input: BlockInput): number; // TODO: I don't know if this makes sense
  addOutput(output: BlockOutput): number;
  setFrontierLevel(level: number): void;
  sign(): void;
  invert(hash: Hash): MaybePromise<Uint8Array>;
  request(
    contractHash: Hash,
    params: Uint8Array,
  ): MaybePromise<Uint8Array>;
  // TODO: requestHash?
  // TODO: requestBlock?
  notify(contractHash: Hash, params: Uint8Array): void;
  fulfills(block: BlockFact, outputIdx: number): void;
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

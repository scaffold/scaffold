import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Contract, Script } from './scriptTypes.ts';
import { bin2hex, hex2bin } from './util/hex.ts';
// import RootContract from '~/graph/RootContract.ts';
import { generatorHash, rootHash } from '~/sbl/constants.ts';
import { Block, PublishMessage, Verifier } from './messages.ts';
import BlockService from './BlockService.ts';
import { FulfillmentRegistry } from './registries.ts';
import QaDebugger from './QaDebugger.ts';

// Hacky
(window as any).hex2bin = hex2bin;

export default class GraphUtils {
  constructor(private ctx: Context) {}

  public supplyRawAnswer(body: Uint8Array) {
    const verifier = {
      contract_hash: rootHash,
      params: Hash.digest(body).toBytes(),
    };
    return this.maybeIngestBlock(verifier, () => ({
      verifier,
      inputs: [],
      outputs: [],
      body,
      timestamp: BigInt(Date.now()),
    }));
  }

  public supplyPubContract(
    contract: (
      publication: PublishMessage,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => boolean | Promise<boolean>,
  ) {
    return this.supplyRawAnswer(new TextEncoder().encode(contract.toString()));
  }

  public supplyContract(
    contract: (
      contractHash: Hash,
      params: Uint8Array,
      hint: Uint8Array,
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
      notify: (contractHash: Hash, params: Uint8Array) => void,
    ) => boolean | Promise<boolean>,
  ) {
    return this.supplyRawAnswer(
      new TextEncoder().encode(
        `(pub,hint,request,notify)=>(${contract.toString()})(pub.question.contract_hash,pub.question.params,hint,request,notify)`,
      ),
    );
  }

  // TODO: Does this work? Depends on how answer consistency is handled in caller.
  public getGeneratorContract() {
    return generatorHash;
  }

  public supplyGenerator(
    contract_hash: Hash,
    generator:
      | Uint8Array
      | Script
      | ((
        contractHash: Hash,
        params: Uint8Array,
        emitCorrect: boolean,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
        notify: (contractHash: Hash, params: Uint8Array) => void,
      ) => Uint8Array | Promise<Uint8Array>),
  ) {
    const verifier = {
      contract_hash: this.getGeneratorContract(),
      params: contract_hash.toBytes(),
    };
    return this.maybeIngestBlock(verifier, () => ({
      verifier,
      inputs: [],
      outputs: [],
      body: generator instanceof Uint8Array
        ? generator
        : new TextEncoder().encode(
          typeof generator === 'function'
            ? generator.toString()
            : `(${
              JSON.stringify(
                generator,
                (key, val) =>
                  val instanceof Uint8Array ? `hex2bin(${bin2hex(val)})` : val,
              ).replace(/"hex2bin\(([0-9a-f]*)\)"/g, 'hex2bin("$1")')
            })`,
        ),
      timestamp: BigInt(Date.now()),
    }));
  }

  private maybeIngestBlock(verifier: Verifier, blockFactory: () => Block) {
    const verifierHash = Hash.digest(Verifier.encode(verifier));
    const existingBlocks =
      this.ctx.get(FulfillmentRegistry).get(verifierHash) || [];
    if (existingBlocks.length) {
      return Hash.digest(Block.encode(existingBlocks[0]));
    } else {
      const block = blockFactory();
      this.ctx.get(BlockService).ingest(block);
      return Hash.digest(Block.encode(block));
    }
  }
}

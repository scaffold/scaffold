import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Contract, Script } from './scriptTypes.ts';
import { bin2hex, hex2bin } from './util/hex.ts';
import RootContract from '~/graph/RootContract.ts';
import { Block, PublishMessage } from './messages.ts';
import BlockService from './BlockService.ts';

// Hacky
(window as any).hex2bin = hex2bin;

export default class GraphUtils {
  constructor(private ctx: Context) {}

  public supplyRawAnswer(body: Uint8Array) {
    const hash = Hash.digest(body);

    return this.ingestBlock({
      claims: [],
      incentives: [],
      verifier: {
        contract_hash: this.ctx.get(RootContract).get(),
        params: hash.toBytes(),
      },
      body,
      timestamp: BigInt(Date.now()),
    });
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
    return this.supplyContract((
      _contractHash: Hash,
      params: Uint8Array, // This is the contract hash we're generating for.
      hint: Uint8Array, // This is the params we're evaluating at.
      request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    ) =>
      eval(
        new TextDecoder().decode(
          request(this.ctx.get(RootContract).get(), params),
        ),
      )(params, hint, new Uint8Array([]), request)
    );
  }

  public supplyGenerator(
    contract_hash: Hash,
    generator:
      | Script
      | ((
        contractHash: Hash,
        params: Uint8Array,
        emitCorrect: boolean,
        request: (contractHash: Hash, params: Uint8Array) => Uint8Array,
        notify: (contractHash: Hash, params: Uint8Array) => void,
      ) => Uint8Array | Promise<Uint8Array>),
  ) {
    return this.ingestBlock({
      verifier: {
        contract_hash: this.getGeneratorContract(),
        params: contract_hash.toBytes(),
      },
      claims: [],
      incentives: [],
      body: new TextEncoder().encode(
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
    });
  }

  public ingestBlock(block: Block) {
    this.ctx.get(BlockService).ingest(block);
    return Hash.digest(Block.encode(block));
  }
}

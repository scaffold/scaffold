import { Hash, ZERO_HASH } from './util/Hash.ts';
import { hex2bin } from './util/hex.ts';
import { Atom, AtomBase, AtomType, BlockPayload, BlockRef } from './core/types.ts';
import { assert } from './util/functional.ts';
import { AtomSerializerModule } from './core/AtomSerializer.ts';
import { Ingestor, serializeBlock, UnknownIngestor } from './core/Ingestor.ts';
import { EntropyProvider } from './Config.ts';
import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { bin2bigintBe } from './util/bigint.ts';
import { str2bin } from './util/buffer.ts';

export class GenesisBlockIngestor implements Ingestor<never> {
  readonly isSigned = true;

  serialize(payload: BlockPayload, allocator: (size: number) => Uint8Array): Uint8Array {
    return serializeBlock(payload, allocator);
  }

  deserialize(_base: AtomBase, _ref?: BlockRef): never {
    throw new Error('Unexpected call');
  }

  ingest(_atom: never): never {
    throw new Error('Unexpected call');
  }
}

class GenesisSerializer extends AtomSerializerModule {
  protected override factories: { [key in AtomType]: Ingestor<Atom> };

  constructor(private seed: string) {
    super();

    this.factories = {
      [AtomType.Block]: new GenesisBlockIngestor(),
      [AtomType.Signal]: new UnknownIngestor(),
      [AtomType.Request]: new UnknownIngestor(),
    };
  }

  protected override getPrivateKey(): Uint8Array {
    return Hash.digest(`scaffold:testnet:${this.seed}`).toBytes();
  }

  protected override getEntropyProvider(): EntropyProvider {
    return new SeededEntropyProvider(bin2bigintBe(str2bin(this.seed)));
  }
}

export function generateGenesis(
  seed: string,
  outputToPublicKeys: Record<string, bigint>,
): Uint8Array {
  const block: BlockPayload = {
    anchor: ZERO_HASH,
    chain: [],
    aggregates: [],
    claims: [],
    refs: [],
    outputs: [],
    timestampMs: 0,
  };
  for (const [publicKeyHex, amount] of Object.entries(outputToPublicKeys)) {
    const publicKey = hex2bin(publicKeyHex);
    assert(publicKey.byteLength === 33, 'public key must be 33 bytes');
    assert(amount >= 0n, 'amount must be non-negative');
    block.outputs.push({ contractHash: ZERO_HASH, params: publicKey, amount });
  }

  const serializer = new GenesisSerializer(seed);
  return serializer.serialize(AtomType.Block, block);
}

// TODO(claude): Create tests/genesis.test.ts and add some tests, including that the genesis block generation is deterministic.

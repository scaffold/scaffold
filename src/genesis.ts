import { Hash, ZERO_HASH } from './util/Hash.ts';
import { hex2bin } from './util/hex.ts';
import { Atom, AtomBase, AtomType, BlockPayload, BlockRef } from './core/types.ts';
import { assert } from './util/functional.ts';
import { AtomSerializerModule } from './core/AtomSerializer.ts';
import { Ingestor, serializeBlock, UnknownIngestor } from './core/Ingestor.ts';
import { EntropyProvider } from './Config.ts';
import { SeededEntropyProvider } from '../plugins/SeededEntropyProvider.ts';
import { bigint2binBe, bin2bigintBe } from './util/bigint.ts';
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

  constructor(private seed: Hash) {
    super();

    this.factories = {
      [AtomType.Block]: new GenesisBlockIngestor(),
      [AtomType.Signal]: new UnknownIngestor(),
      [AtomType.Request]: new UnknownIngestor(),
    };
  }

  protected override getPrivateKey(): Uint8Array {
    return this.seed.toBytes();
  }

  protected override getEntropyProvider(): EntropyProvider {
    return new SeededEntropyProvider(this.seed.toBigint());
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

  const randomness: (Uint8Array | string)[] = [seed];
  for (const [publicKeyHex, amount] of Object.entries(outputToPublicKeys)) {
    const publicKey = hex2bin(publicKeyHex);
    assert(publicKey.byteLength === 33, 'public key must be 33 bytes');
    assert(amount >= 0n, 'amount must be non-negative');
    block.outputs.push({ contract: ZERO_HASH, params: publicKey, amount });

    randomness.push(publicKey, bigint2binBe(amount));
  }

  // Create a new seed hash whenever the seed or output set changes, so there's no risk of signing multiple blocks with the same randomness.
  const serializer = new GenesisSerializer(Hash.digestParts(...randomness));
  return serializer.serialize(AtomType.Block, block);
}

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { SeededEntropyProvider } from '../../plugins/SeededEntropyProvider.ts';
import { EntropyProvider } from '../../src/Config.ts';
import { AtomSerializer, AtomSerializerBase, headerSize } from '../../src/graph/AtomSerializer.ts';
import { Ingestor } from '../../src/graph/Ingestor.ts';
import {
  Atom,
  AtomBase,
  AtomSource,
  AtomType,
  BlockPayload,
  Signal,
} from '../../src/graph/types.ts';
import { generateGenesis } from '../../src/graph/genesis.ts';
import { bigint2binBe, bin2bigintBe } from '../../src/util/bigint.ts';
import { Hash, ZERO_HASH } from '../../src/util/Hash.ts';
import { bin2hex } from '../../src/util/hex.ts';
import { secp } from '../../src/util/secp.ts';
import { makeTestContext, testPrivateKey, testPublicKey } from '../helpers/v2.ts';

const MAGIC = new Uint8Array([83, 67, 70]);
const SIG_LENGTH = 65;
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

const blockPayload = (overrides: Partial<BlockPayload> = {}): BlockPayload => ({
  anchor: ZERO_HASH,
  chain: [],
  aggregates: [],
  claims: [],
  refs: [],
  outputs: [],
  timestampMs: 0,
  ...overrides,
});

const received = (raw: Uint8Array) => ({
  hash: Hash.digest(raw),
  source: AtomSource.Local,
  receivedAt: 0,
  raw,
});

const makeService = (selfPrivateKey?: Uint8Array) =>
  new AtomSerializer(makeTestContext({ selfPrivateKey }));

/** Writes the payload bytes verbatim, so the wire format can be tested without the block codec. */
class RawIngestor implements Ingestor<Signal> {
  isSigned: boolean;
  allocated: number[] = [];
  window?: Uint8Array;

  constructor(isSigned: boolean) {
    this.isSigned = isSigned;
  }

  serialize(payload: Signal['payload'], allocator: (size: number) => Uint8Array): Uint8Array {
    const bytes = payload as Uint8Array;
    const buf = allocator(bytes.byteLength);
    this.allocated.push(buf.byteLength);
    this.window = buf;
    buf.set(bytes);
    return buf;
  }

  deserialize(base: AtomBase): Signal {
    return { ...base, type: AtomType.Signal, payload: {} };
  }

  ingest(): void {}
}

/** Second instantiation of the abstract module, as `GenesisSerializer` in src/graph/genesis.ts is. */
class TestSerializer extends AtomSerializerBase {
  protected override factories: { [key in AtomType]: Ingestor<Atom> };
  private entropy = new SeededEntropyProvider(7n);

  constructor(private privateKey: Uint8Array, ingestor: Ingestor<Atom>) {
    super();
    this.factories = {
      [AtomType.Block]: ingestor,
      [AtomType.Signal]: ingestor,
      [AtomType.Request]: ingestor,
    };
  }

  protected override getPrivateKey(): Uint8Array {
    return this.privateKey;
  }

  protected override getEntropyProvider(): EntropyProvider {
    return this.entropy;
  }
}

const rawAtom = (isSigned: boolean, bytes: Uint8Array, key = testPrivateKey('alice')) => {
  const ingestor = new RawIngestor(isSigned);
  const serializer = new TestSerializer(key, ingestor);
  return { ingestor, serializer, raw: serializer.serialize(AtomType.Signal, bytes) };
};

Deno.test('headerSize is the magic bytes plus the type byte', () => {
  assertEquals(headerSize, 4);
});

Deno.test('serialize writes the SCF magic and the type byte', () => {
  const raw = makeService().serialize(AtomType.Block, blockPayload());
  assertEquals(raw.subarray(0, 3), MAGIC);
  assertEquals(raw[3], AtomType.Block);
});

Deno.test('serialize gives the ingestor a window of exactly the requested size, after the header', () => {
  const body = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const { ingestor, raw } = rawAtom(false, body);
  assertEquals(ingestor.allocated, [body.byteLength]);
  assertEquals(raw.byteLength, headerSize + body.byteLength);
  assertEquals(raw.subarray(headerSize), body);
  assertEquals(ingestor.window!.byteOffset, headerSize);
});

Deno.test('an unsigned atom carries no signature', () => {
  const body = new Uint8Array([9, 9]);
  const { serializer, raw } = rawAtom(false, body);
  assertEquals(raw.byteLength, headerSize + body.byteLength);

  const atom = serializer.deserialize(received(raw));
  assertEquals(atom.message, body);
  assertEquals(atom.signature, undefined);
  assertEquals(atom.signer, undefined);
});

Deno.test('a signed atom appends a 65-byte signature', () => {
  const body = new Uint8Array([9, 9]);
  const { serializer, raw } = rawAtom(true, body);
  assertEquals(raw.byteLength, headerSize + body.byteLength + SIG_LENGTH);

  const atom = serializer.deserialize(received(raw));
  assertEquals(atom.message, body);
  assertEquals(atom.signature!.byteLength, SIG_LENGTH);
  assertEquals(atom.signature, raw.subarray(-SIG_LENGTH));
});

Deno.test('deserialize recovers the compressed public key of the signing key', () => {
  const privateKey = testPrivateKey('bob');
  const service = makeService(privateKey);
  const raw = service.serialize(AtomType.Block, blockPayload({ timestampMs: 42 }));

  const atom = service.deserialize(received(raw));
  assertEquals(atom.signer!.byteLength, 33);
  assertEquals(bin2hex(atom.signer!), bin2hex(secp.getPublicKey(privateKey, true)));
  assertEquals(bin2hex(atom.signer!), bin2hex(testPublicKey('bob')));
});

Deno.test('the recovery byte is in range 0..3', () => {
  const service = makeService();
  for (let i = 0; i < 16; i++) {
    const raw = service.serialize(AtomType.Block, blockPayload({ timestampMs: i }));
    assert(raw[raw.byteLength - 1] <= 3, `recovery byte ${raw[raw.byteLength - 1]} out of range`);
  }
});

Deno.test('the signature commits to the type byte', () => {
  const { serializer, raw } = rawAtom(true, new Uint8Array([1, 2, 3]));
  const signer = serializer.deserialize(received(raw)).signer!;

  const retyped = new Uint8Array(raw);
  retyped[3] = AtomType.Block;
  assertNotEquals(bin2hex(serializer.deserialize(received(retyped)).signer!), bin2hex(signer));
});

Deno.test('the signature commits to every message byte', () => {
  const body = new Uint8Array([1, 2, 3, 4]);
  const { serializer, raw } = rawAtom(true, body);
  const signer = serializer.deserialize(received(raw)).signer!;

  for (let i = headerSize; i < headerSize + body.byteLength; i++) {
    const tampered = new Uint8Array(raw);
    tampered[i] ^= 0x40;
    assertNotEquals(
      bin2hex(serializer.deserialize(received(tampered)).signer!),
      bin2hex(signer),
      `byte ${i} is not covered by the signature`,
    );
  }
});

Deno.test('deserialize keeps the received raw as the atom identity', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());
  const atom = service.deserialize(received(raw));
  assertStrictEquals(atom.raw, raw);
  assertEquals(atom.type, AtomType.Block);
  assertEquals(atom.source, AtomSource.Local);
});

Deno.test('a block payload survives the round trip by value', () => {
  const service = makeService();
  const payload = blockPayload(
    {
      anchor: Hash.digest('anchor'),
      chain: [{ weight: 2n ** 70n, throughput: 5n }, { weight: 0n, throughput: 2n ** 64n }],
      aggregates: [{ block: Hash.digest('agg'), outputCount: 3n }],
      claims: [0n, 1n],
      refs: [1n],
      outputs: [
        { contract: Hash.digest('c0'), params: new Uint8Array([1, 2, 3]), amount: 2n ** 80n + 7n },
        {
          contract: ZERO_HASH,
          params: new Uint8Array(),
          data: new Uint8Array([255, 0, 128]),
          amount: 0n,
        },
      ],
      timestampMs: 1234567,
    } satisfies BlockPayload,
  );

  const atom = service.deserialize(received(service.serialize(AtomType.Block, payload)));
  assert(atom.type === AtomType.Block);
  assertEquals(atom.payload.anchor, payload.anchor);
  assertEquals(atom.payload.chain, payload.chain);
  assertEquals(atom.payload.aggregates[0].block, payload.aggregates[0].block);
  assertEquals(atom.payload.aggregates[0].outputCount, 3n);
  assertEquals(atom.payload.claims, [0n, 1n]);
  assertEquals(atom.payload.refs, [1n]);
  assertEquals(atom.payload.outputs[0].amount, 2n ** 80n + 7n);
  assertEquals(atom.payload.outputs[0].params, new Uint8Array([1, 2, 3]));
  assertEquals(atom.payload.outputs[0].data, undefined);
  assertEquals(atom.payload.outputs[1].data, new Uint8Array([255, 0, 128]));
  assertEquals(atom.payload.timestampMs, 1234567);
});

Deno.test('deserialize rejects a raw shorter than the header', () => {
  const service = makeService();
  for (const size of [0, 1, 3]) {
    assertThrows(
      () => service.deserialize(received(new Uint8Array(size))),
      Error,
      'too short',
    );
  }
});

Deno.test('deserialize rejects a raw without the magic bytes', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());

  for (let i = 0; i < MAGIC.byteLength; i++) {
    const tampered = new Uint8Array(raw);
    tampered[i] ^= 1;
    assertThrows(() => service.deserialize(received(tampered)), Error, 'magic');
  }
});

Deno.test('deserialize rejects an unknown type byte', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());

  for (const type of [3, 42, 255]) {
    const tampered = new Uint8Array(raw);
    tampered[3] = type;
    assertThrows(
      () => service.deserialize(received(tampered)),
      Error,
      `Invalid message type ${type}!`,
    );
  }
});

Deno.test('deserialize rejects a signed raw too short to hold a signature', () => {
  const { serializer } = rawAtom(true, new Uint8Array());

  for (const size of [headerSize, headerSize + 1, headerSize + SIG_LENGTH - 1]) {
    const raw = new Uint8Array(size);
    raw.set(MAGIC);
    raw[3] = AtomType.Signal;
    assertThrows(() => serializer.deserialize(received(raw)), Error, 'too short');
  }
});

Deno.test('deserialize rejects an out-of-range recovery byte', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());

  for (const bit of [4, 7, 255]) {
    const tampered = new Uint8Array(raw);
    tampered[tampered.byteLength - 1] = bit;
    assertThrows(() => service.deserialize(received(tampered)), Error);
  }
});

Deno.test('deserialize rejects an all-zero signature', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());
  const tampered = new Uint8Array(raw);
  tampered.fill(0, tampered.byteLength - SIG_LENGTH);
  assertThrows(() => service.deserialize(received(tampered)), Error);
});

// A corrupted signature is not detectable here: recovery yields whichever key would
// have signed these bytes. Nothing is silently dropped -- the atom just carries a
// different `signer`, and the contract check on the claimed output is what rejects it.
Deno.test('a corrupted signature recovers a different signer rather than throwing', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());
  const signer = service.deserialize(received(raw)).signer!;

  const tampered = new Uint8Array(raw);
  tampered[tampered.byteLength - SIG_LENGTH] ^= 1;
  const other = service.deserialize(received(tampered)).signer!;
  assertEquals(other.byteLength, 33);
  assertNotEquals(bin2hex(other), bin2hex(signer));
});

// ECDSA is malleable: flipping s to n - s and the recovery bit with it yields a raw that
// recovers the same signer under a different hash. Enforcing low-S is what stops a third
// party minting that variant without the author's key.
Deno.test('a high-S variant of a signed raw is rejected', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());

  const variant = new Uint8Array(raw);
  const sigStart = variant.byteLength - SIG_LENGTH;
  const s = bin2bigintBe(variant.subarray(sigStart + 32, sigStart + 64));
  variant.set(bigint2binBe(SECP_N - s, 32), sigStart + 32);
  variant[variant.byteLength - 1] ^= 1;

  assertNotEquals(Hash.digest(variant).toHex(), Hash.digest(raw).toHex());
  assertThrows(() => service.deserialize(received(variant)), Error, 'high S');
});

Deno.test('deserialize surfaces an ingestor rejection instead of swallowing it', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());
  const tampered = new Uint8Array(raw);
  tampered[headerSize] = 0x21; // '!' -- a body the block codec cannot parse

  assertThrows(() => service.deserialize(received(tampered)));
});

Deno.test('deserialize trusts the caller-supplied hash', () => {
  const service = makeService();
  const raw = service.serialize(AtomType.Block, blockPayload());
  const atom = service.deserialize({
    hash: Hash.digest('not the raw'),
    source: AtomSource.Remote,
    receivedAt: 5,
    raw,
  });
  assertEquals(atom.hash.toHex(), Hash.digest('not the raw').toHex());
  assertNotEquals(atom.hash.toHex(), Hash.digest(raw).toHex());
});

Deno.test('unknown atom types are unimplemented rather than serializable', () => {
  const service = makeService();
  assertThrows(() => service.serialize(AtomType.Signal, {}));

  const raw = service.serialize(AtomType.Block, blockPayload());
  const tampered = new Uint8Array(raw);
  tampered[3] = AtomType.Signal;
  assertThrows(() => service.deserialize(received(tampered)));
});

Deno.test('identically seeded contexts serialize the same payload to identical bytes', () => {
  const a = makeService();
  const b = makeService();
  assertEquals(
    bin2hex(a.serialize(AtomType.Block, blockPayload({ timestampMs: 3 }))),
    bin2hex(b.serialize(AtomType.Block, blockPayload({ timestampMs: 3 }))),
  );
});

// Signing draws fresh extra entropy per call, so `raw` is not a function of the payload.
// Only the appended signature differs; the header and message are byte-identical.
Deno.test('serializing the same payload twice from one context yields different signatures', () => {
  const service = makeService();
  const first = service.serialize(AtomType.Block, blockPayload());
  const second = service.serialize(AtomType.Block, blockPayload());

  assertEquals(
    bin2hex(first.subarray(0, first.byteLength - SIG_LENGTH)),
    bin2hex(second.subarray(0, second.byteLength - SIG_LENGTH)),
  );
  assertNotEquals(bin2hex(first), bin2hex(second));
});

Deno.test('serializing different keys with the same entropy yields different signers', () => {
  const alice = makeService(testPrivateKey('alice'));
  const bob = makeService(testPrivateKey('bob'));
  const payload = blockPayload({ timestampMs: 11 });

  assertEquals(
    bin2hex(alice.deserialize(received(alice.serialize(AtomType.Block, payload))).signer!),
    bin2hex(testPublicKey('alice')),
  );
  assertEquals(
    bin2hex(bob.deserialize(received(bob.serialize(AtomType.Block, payload))).signer!),
    bin2hex(testPublicKey('bob')),
  );
});

Deno.test('generateGenesis is deterministic in its seed and funding', () => {
  const funding = { [bin2hex(testPublicKey('alice'))]: 1_000n };
  assertEquals(bin2hex(generateGenesis('s', funding)), bin2hex(generateGenesis('s', funding)));

  assertNotEquals(
    bin2hex(generateGenesis('other', funding)),
    bin2hex(generateGenesis('s', funding)),
  );
  assertNotEquals(
    bin2hex(generateGenesis('s', { [bin2hex(testPublicKey('alice'))]: 1_001n })),
    bin2hex(generateGenesis('s', funding)),
  );
});

Deno.test('a genesis block written by GenesisSerializer is readable by AtomSerializer', () => {
  const raw = generateGenesis('s', { [bin2hex(testPublicKey('alice'))]: 1_000n });
  assertEquals(raw.subarray(0, 3), MAGIC);
  assertEquals(raw[3], AtomType.Block);

  const atom = makeService().deserialize({
    hash: Hash.digest(raw),
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw,
  });
  assert(atom.type === AtomType.Block);
  assertEquals(atom.signer!.byteLength, 33);
  assertEquals(atom.payload.outputs.length, 1);
  assertEquals(atom.payload.outputs[0].amount, 1_000n);
  assertEquals(atom.payload.outputs[0].params, testPublicKey('alice'));
  assertEquals(atom.payload.anchor, ZERO_HASH);
});

Deno.test('the genesis signer is not the node key and is stable across regeneration', () => {
  const funding = { [bin2hex(testPublicKey('alice'))]: 1_000n };
  const service = makeService();
  const first = service.deserialize(received(generateGenesis('s', funding)));
  const second = service.deserialize(received(generateGenesis('s', funding)));

  assertEquals(bin2hex(first.signer!), bin2hex(second.signer!));
  assertNotEquals(bin2hex(first.signer!), bin2hex(testPublicKey('alice')));
});

Deno.test('an ingestor that never allocates fails loudly', () => {
  const serializer = new TestSerializer(testPrivateKey('alice'), {
    isSigned: false,
    serialize: () => new Uint8Array(),
    deserialize: (base: AtomBase): Signal => ({ ...base, type: AtomType.Signal, payload: {} }),
    ingest: () => {},
  });

  assertThrows(() => serializer.serialize(AtomType.Signal, new Uint8Array([1])));
});

Deno.test('an ingestor that allocates twice silently loses the first buffer', () => {
  const body = new Uint8Array([1, 2, 3]);
  const serializer = new TestSerializer(testPrivateKey('alice'), {
    isSigned: false,
    serialize: (payload: Signal['payload'], allocator: (size: number) => Uint8Array) => {
      allocator(body.byteLength).set(payload as Uint8Array);
      return allocator(body.byteLength);
    },
    deserialize: (base: AtomBase): Signal => ({ ...base, type: AtomType.Signal, payload: {} }),
    ingest: () => {},
  });

  const raw = serializer.serialize(AtomType.Signal, body);
  assertEquals(raw.subarray(headerSize), new Uint8Array(body.byteLength));
});

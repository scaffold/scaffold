import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { BlockPayload } from '../src/core/Block.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { deriveIdentity } from '../src/demo/Identity.ts';
import { makeStatusOutput } from '../src/demo/StatusContract.ts';
import {
  composeBlockPacket,
  composeGenesisPacket,
  composeUnsignedBlockPacket,
  HEADER_SIZE,
  isSigned,
  PACKET_MAGIC,
  PacketType,
  parsePacket,
  recoverPacketSigner,
  SIGNATURE_SIZE,
  verifyPacketSignature,
} from '../src/core/Packet.ts';

// -- Helpers --------------------------------------------------------

function makeGenesisOutputs(): Output[] {
  const eagle = deriveIdentity('eagle');
  return [makeStatusOutput(eagle.publicKey, 'hello')];
}

function makeSignedBlockPacket() {
  const eagle = deriveIdentity('eagle');
  const { block: genesis } = composeGenesisPacket(makeGenesisOutputs());
  const blueprint = {
    anchor: genesis.hash,
    aggregates: [] as Hash[],
    claims: [] as number[],
    outputs: [makeStatusOutput(eagle.publicKey, 'update')],
    declaredWeight: 1,
    refs: [] as Hash[],
  };
  return { ...composeBlockPacket(blueprint, eagle.privateKey), eagle };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// -- Tests ----------------------------------------------------------

Deno.test('Packet: signed block compose/parse roundtrip', () => {
  const { block, packet } = makeSignedBlockPacket();

  const parsed = parsePacket<BlockPayload>(packet.raw);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.Block);
  assert(Hash.equals(parsed!.hash, packet.hash));
  assert(Hash.equals(parsed!.hash, block.hash));
  assert(Hash.equals(parsed!.payload.anchor, block.anchor));
  assertEquals(parsed!.payload.declaredWeight, block.declaredWeight);
  assertEquals(parsed!.payload.outputs.length, block.outputs.length);
  assert(parsed!.signature !== undefined);
  assertEquals(parsed!.signature!.length, SIGNATURE_SIZE);
});

Deno.test('Packet: unsigned block compose/parse roundtrip', () => {
  const eagle = deriveIdentity('eagle');
  const { block: genesis } = composeGenesisPacket(makeGenesisOutputs());
  const blueprint = {
    anchor: genesis.hash,
    aggregates: [] as Hash[],
    claims: [] as number[],
    outputs: [makeStatusOutput(eagle.publicKey, 'unsigned')],
    declaredWeight: 1,
    refs: [] as Hash[],
  };
  const { block, packet } = composeUnsignedBlockPacket(blueprint);

  const parsed = parsePacket<BlockPayload>(packet.raw);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.UnsignedBlock);
  assert(Hash.equals(parsed!.hash, block.hash));
  assert(parsed!.signature === undefined);
  assert(Hash.equals(parsed!.payload.anchor, block.anchor));
});

Deno.test('Packet: genesis compose/parse roundtrip', () => {
  const { block, packet } = composeGenesisPacket(makeGenesisOutputs());

  const parsed = parsePacket<BlockPayload>(packet.raw);
  assert(parsed !== null);
  assertEquals(parsed!.type, PacketType.UnsignedBlock);
  assert(Hash.equals(parsed!.hash, block.hash));
  assertEquals(parsed!.payload.outputs.length, 1);
  assertEquals(block.declaredWeight, Number.MAX_SAFE_INTEGER);
});

Deno.test('Packet: signature verification succeeds with correct key', () => {
  const { packet, eagle } = makeSignedBlockPacket();

  assert(verifyPacketSignature(packet, eagle.publicKey));
});

Deno.test('Packet: signature verification fails with wrong key', () => {
  const { packet } = makeSignedBlockPacket();
  const badger = deriveIdentity('badger');

  assertFalse(verifyPacketSignature(packet, badger.publicKey));
});

Deno.test('Packet: signer recovery returns correct public key', () => {
  const { packet, eagle } = makeSignedBlockPacket();

  const recovered = recoverPacketSigner(packet);
  assert(recovered !== undefined);
  assert(bytesEqual(recovered!, eagle.publicKey));
});

Deno.test('Packet: hash equals Hash.digest(raw) invariant', () => {
  const { packet } = makeSignedBlockPacket();
  const recomputed = Hash.digest(packet.raw);
  assert(Hash.equals(packet.hash, recomputed));

  // Also for unsigned
  const { packet: unsignedPacket } = composeGenesisPacket(makeGenesisOutputs());
  const recomputed2 = Hash.digest(unsignedPacket.raw);
  assert(Hash.equals(unsignedPacket.hash, recomputed2));
});

Deno.test('Packet: different signers produce different hashes', () => {
  const eagle = deriveIdentity('eagle');
  const badger = deriveIdentity('badger');
  const { block: genesis } = composeGenesisPacket(makeGenesisOutputs());
  const blueprint = {
    anchor: genesis.hash,
    aggregates: [] as Hash[],
    claims: [] as number[],
    outputs: [makeStatusOutput(eagle.publicKey, 'same payload')],
    declaredWeight: 1,
    refs: [] as Hash[],
  };

  const { packet: p1 } = composeBlockPacket(blueprint, eagle.privateKey);
  const { packet: p2 } = composeBlockPacket(blueprint, badger.privateKey);

  assertFalse(Hash.equals(p1.hash, p2.hash));
});

Deno.test('Packet: rejects bad magic bytes', () => {
  const { packet } = makeSignedBlockPacket();
  const corrupted = new Uint8Array(packet.raw);
  corrupted[0] = 0; // corrupt magic

  const parsed = parsePacket<BlockPayload>(corrupted);
  assertEquals(parsed, null);
});

Deno.test('Packet: rejects truncated data', () => {
  const { packet } = makeSignedBlockPacket();
  // Truncate to just header
  const truncated = packet.raw.subarray(0, HEADER_SIZE);

  const parsed = parsePacket<BlockPayload>(truncated);
  assertEquals(parsed, null);
});

Deno.test('Packet: rejects unknown type', () => {
  const raw = new Uint8Array([PACKET_MAGIC[0], PACKET_MAGIC[1], PACKET_MAGIC[2], 255]);
  const parsed = parsePacket<BlockPayload>(raw);
  assertEquals(parsed, null);
});

Deno.test('Packet: isSigned returns correct values', () => {
  assert(isSigned(PacketType.Block));
  assertFalse(isSigned(PacketType.UnsignedBlock));
});

Deno.test('Packet: verifyPacketSignature returns false for unsigned packets', () => {
  const { packet } = composeGenesisPacket(makeGenesisOutputs());
  const eagle = deriveIdentity('eagle');
  assertFalse(verifyPacketSignature(packet, eagle.publicKey));
});

Deno.test('Packet: recoverPacketSigner returns undefined for unsigned packets', () => {
  const { packet } = composeGenesisPacket(makeGenesisOutputs());
  assertEquals(recoverPacketSigner(packet), undefined);
});

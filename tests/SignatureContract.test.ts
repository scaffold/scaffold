import { assert, assertEquals, assertFalse } from '@std/assert';

import { Hash } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import {
  AtomSource,
  AtomType,
  Block,
  composeBlockPacket,
  composeGenesisPacket,
  createGenesisBlock,
  parseBlockPacket,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { PacketType } from '../src/core/Packet.ts';
import { signatureContract } from '../src/contracts/SignatureContract.ts';
import { type ContractEnv } from '../src/core/ContractEnv.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { SimNode } from './SimNetwork.ts';

// -- Helpers ----------------------------------------------------------

const privateKeyA = secp.utils.randomPrivateKey();
const publicKeyA = secp.getPublicKey(privateKeyA, true);
const privateKeyB = secp.utils.randomPrivateKey();
const publicKeyB = secp.getPublicKey(privateKeyB, true);

function makeSignedBlock(
  anchor: Block,
  outputs: { verifier: { contract: Hash; params: Uint8Array }; value: number; data: Uint8Array }[],
  declaredWeight: number,
  claimIndices: number[],
  privateKey: Uint8Array,
): Block {
  const block = composeBlockPacket(
    {
      anchor: anchor.hash,
      aggregates: [],
      claimIndices,
      outputs,
      declaredWeight,
      refs: [],
      timestamp: 0,
    },
    privateKey,
  );
  return block;
}

// -- Tests ------------------------------------------------------------

Deno.test('SignatureContract: signed block with matching key is accepted', async () => {
  const node = new SimNode('sig-test');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Genesis with a signature output spendable by keyA
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Block signed by keyA, claiming the signature output
  const block = makeSignedBlock(genesis, [], 10, [0], privateKeyA);
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assert(result.accepted, `Should accept: signed by correct key`);
});

Deno.test('SignatureContract: signed block with wrong key is rejected', async () => {
  const node = new SimNode('sig-test-wrong');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Genesis with a signature output spendable by keyA
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Block signed by keyB, but claiming output locked to keyA
  const block = makeSignedBlock(genesis, [], 10, [0], privateKeyB);
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assertFalse(result.accepted, `Should reject: signed by wrong key`);
});

Deno.test('SignatureContract: unsigned block is rejected', async () => {
  const node = new SimNode('sig-test-unsigned');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Genesis with a signature output spendable by keyA
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Unsigned block (no signer) claiming the signature output
  const unsignedBlock: Block = {
    hash: Hash.digest('unsigned-block'),
    anchor: genesis.hash,
    aggregates: [],
    claimIndices: [0],
    outputs: [],
    declaredWeight: 10,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
    // no signer field
  };
  node.receiveBlock(unsignedBlock, null);

  const result = await node.execution.verifyBlock(unsignedBlock.hash);
  assertFalse(result.accepted, `Should reject: block is not signed`);
});

Deno.test('SignatureContract: block signer is populated by composeBlockPacket', () => {
  const block = composeBlockPacket(
    {
      anchor: Hash.digest('test-anchor'),
      aggregates: [],
      claimIndices: [],
      outputs: [],
      declaredWeight: 1,
      refs: [],
      timestamp: 0,
    },
    privateKeyA,
  );

  assert(block.signer !== undefined, 'Block should have signer');
  assert(
    block.signer!.length === 33,
    `Signer should be 33-byte compressed pubkey, got ${block.signer!.length}`,
  );

  // Signer should match the public key derived from the private key
  for (let i = 0; i < publicKeyA.length; i++) {
    assert(
      block.signer![i] === publicKeyA[i],
      `Signer byte ${i} mismatch`,
    );
  }
});

Deno.test('SignatureContract: ingest path recovers signer from wire packet', async () => {
  const node = new SimNode('sig-ingest');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Compose a signed packet, then simulate wire transit by parsing the
  // raw bytes back into a Block -- mirroring what an ingest path
  // (e.g. PeerConnection.handleMessage) does.
  const composed = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0],
      outputs: [],
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    privateKeyA,
  );

  const ingestedBlock = parseBlockPacket(composed.raw, AtomSource.Remote);
  assert(ingestedBlock !== null);
  assert(ingestedBlock!.signer !== undefined, 'Signer should be recoverable from packet');

  node.receiveBlock(ingestedBlock!, 'peerA');
  const result = await node.execution.verifyBlock(ingestedBlock!.hash);
  assert(result.accepted, 'Ingested signed block should pass signature contract');
});

Deno.test('SignatureContract: ingest path rejects wrong-key signature contract', async () => {
  const node = new SimNode('sig-ingest-wrong');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Output requires keyA, but we sign and ingest with keyB.
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  const composed = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0],
      outputs: [],
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    privateKeyB,
  );

  const ingestedBlock = parseBlockPacket(composed.raw, AtomSource.Remote)!;

  node.receiveBlock(ingestedBlock, 'peerA');
  const result = await node.execution.verifyBlock(ingestedBlock.hash);
  assertFalse(result.accepted, 'Wrong signer should be rejected after ingest');
});

Deno.test('SignatureContract: Scaffold auto-registers signatureContract for verification', async () => {
  const genesis = composeGenesisPacket([makeSignatureOutput(publicKeyA, 100)]);
  const scaffold = new Scaffold({ genesis, privateKey: privateKeyA });

  // The execution service should know about SIGNATURE_CONTRACT without any
  // explicit registerContract() call -- it's wired in NodeContext.
  const contract = scaffold.context.execution.getContract(SIGNATURE_CONTRACT);
  assert(contract !== undefined, 'SIGNATURE_CONTRACT should be auto-registered');
  assertEquals(contract, signatureContract);

  // End-to-end: a signed block claiming the genesis signature output should
  // verify successfully via the execution service.
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0],
      outputs: [],
      declaredWeight: 1,
      refs: [],
      timestamp: 0,
    },
    privateKeyA,
  );
  scaffold.context.coordinator.blockReceived(block, null);
  const result = await scaffold.context.execution.verifyBlock(block.hash);
  assert(result.accepted, 'auto-registered signatureContract should verify the block');
});

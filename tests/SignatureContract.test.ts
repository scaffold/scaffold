import { assert, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { secp } from '../src/util/secp.ts';
import {
  Block,
  BlockSource,
  createGenesisBlock,
  makeSignatureOutput,
  SIGNATURE_CONTRACT,
} from '../src/core/Block.ts';
import { composeBlockPacket } from '../src/core/Packet.ts';
import { signatureContract } from '../src/core/SignatureContract.ts';
import { type ContractEnv } from '../src/core/ContractEnv.ts';
import { SimNode } from './SimNetwork.ts';

// -- Helpers ----------------------------------------------------------

const privateKeyA = secp.utils.randomPrivateKey();
const publicKeyA = secp.getPublicKey(privateKeyA, true);
const privateKeyB = secp.utils.randomPrivateKey();
const publicKeyB = secp.getPublicKey(privateKeyB, true);

function makeSignedBlock(
  anchor: Block,
  outputs: { verifier: { contract: Hash; params: Uint8Array }; value: number; detail: Uint8Array }[],
  declaredWeight: number,
  claims: number[],
  privateKey: Uint8Array,
): Block {
  const { block } = composeBlockPacket(
    {
      anchor: anchor.hash,
      aggregates: [],
      claims,
      outputs,
      declaredWeight,
      refs: [],
    },
    privateKey,
  );
  return block;
}

// -- Tests ------------------------------------------------------------

Deno.test('SignatureContract: signed block with matching key is accepted', () => {
  const node = new SimNode('sig-test');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Genesis with a signature output spendable by keyA
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Block signed by keyA, claiming the signature output
  const block = makeSignedBlock(genesis, [], 10, [0], privateKeyA);
  node.receiveBlock(block, null);

  const result = node.execution.verifyBlock(block.hash);
  assert(result.accepted, `Should accept: signed by correct key`);
});

Deno.test('SignatureContract: signed block with wrong key is rejected', () => {
  const node = new SimNode('sig-test-wrong');
  node.execution.registerContract(SIGNATURE_CONTRACT, signatureContract);

  // Genesis with a signature output spendable by keyA
  const genesis = createGenesisBlock([makeSignatureOutput(publicKeyA, 100)]);
  node.receiveBlock(genesis, null);

  // Block signed by keyB, but claiming output locked to keyA
  const block = makeSignedBlock(genesis, [], 10, [0], privateKeyB);
  node.receiveBlock(block, null);

  const result = node.execution.verifyBlock(block.hash);
  assertFalse(result.accepted, `Should reject: signed by wrong key`);
});

Deno.test('SignatureContract: unsigned block is rejected', () => {
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
    claims: [0],
    outputs: [],
    declaredWeight: 10,
    refs: [],
    timestamp: 0,
    receivedAt: 0,
    source: BlockSource.Local,
    // no signer field
  };
  node.receiveBlock(unsignedBlock, null);

  const result = node.execution.verifyBlock(unsignedBlock.hash);
  assertFalse(result.accepted, `Should reject: block is not signed`);
});

Deno.test('SignatureContract: block signer is populated by composeBlockPacket', () => {
  const { block } = composeBlockPacket(
    {
      anchor: Hash.digest('test-anchor'),
      aggregates: [],
      claims: [],
      outputs: [],
      declaredWeight: 1,
      refs: [],
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

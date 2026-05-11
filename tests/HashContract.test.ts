import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  composeBlockPacket,
  composeGenesisPacket,
  createGenesisBlock,
  HASH_CONTRACT,
  RECORD_CONTRACT,
} from '../src/core/Block.ts';
import { hashContract } from '../src/contracts/HashContract.ts';
import { makeRecordOutput, recordContract } from '../src/contracts/RecordContract.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { secp } from '../src/util/secp.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { SimNode } from './SimNetwork.ts';

Deno.test('HashContract: Scaffold auto-registers hashContract', () => {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const genesis = composeGenesisPacket([makeSignatureOutput(publicKey, 100)]);
  const scaffold = new Scaffold({ genesis, privateKey });
  const contract = scaffold.context.execution.getContract(HASH_CONTRACT);
  assert(contract !== undefined, 'HASH_CONTRACT should be auto-registered');
  assertEquals(contract, hashContract);
});

Deno.test('HashContract: block with matching preimage verifies', async () => {
  const node = new SimNode('hash-test');
  node.execution.registerContract(HASH_CONTRACT, hashContract);
  node.execution.registerContract(RECORD_CONTRACT, recordContract);

  const genesis = createGenesisBlock([]);
  node.receiveBlock(genesis, null);

  // Single-block setup for the test (production typically uses two blocks --
  // the HASH_CONTRACT incentive lives on a request block, claimed by a
  // responder publishing the 'default' record). Both shapes exercise the
  // same hashContract.run logic; the single-block form is simpler to set up.
  const blob = new TextEncoder().encode('the quick brown fox');
  const blobHash = Hash.digest(blob);
  const outputs = [
    {
      verifier: { contract: HASH_CONTRACT, params: blobHash.toBytes() },
      value: 0,
      body: new Uint8Array(0),
    },
    makeRecordOutput('default', blob),
  ];
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0, 1],
      outputs,
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    secp.utils.randomPrivateKey(),
  );
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assert(result.accepted, `expected accept; rejected with: ${JSON.stringify(result)}`);
});

Deno.test('HashContract: block with mismatched preimage is rejected', async () => {
  const node = new SimNode('hash-mismatch');
  node.execution.registerContract(HASH_CONTRACT, hashContract);
  node.execution.registerContract(RECORD_CONTRACT, recordContract);

  const genesis = createGenesisBlock([]);
  node.receiveBlock(genesis, null);

  // The beacon claims hash(X), but the 'default' record body is Y.
  const claimedBlob = new TextEncoder().encode('claimed');
  const actualBlob = new TextEncoder().encode('different');
  const claimedHash = Hash.digest(claimedBlob);
  const outputs = [
    {
      verifier: { contract: HASH_CONTRACT, params: claimedHash.toBytes() },
      value: 0,
      body: new Uint8Array(0),
    },
    makeRecordOutput('default', actualBlob),
  ];
  const block = composeBlockPacket(
    {
      anchor: genesis.hash,
      aggregates: [],
      claimIndices: [0, 1],
      outputs,
      declaredWeight: 10,
      refs: [],
      timestamp: 0,
    },
    secp.utils.randomPrivateKey(),
  );
  node.receiveBlock(block, null);

  const result = await node.execution.verifyBlock(block.hash);
  assertFalse(result.accepted, 'expected rejection on preimage mismatch');
});

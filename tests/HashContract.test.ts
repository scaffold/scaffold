import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import {
  composeBlockPacket,
  composeGenesisPacket,
  createGenesisBlock,
  HASH_CONTRACT,
  RECORD_CONTRACT,
} from '../src/core/Block.ts';
import { hashContract, makeHashContractOutputs } from '../src/contracts/HashContract.ts';
import {
  findRecordOutput,
  makeRecordOutput,
  recordContract,
} from '../src/contracts/RecordContract.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { secp } from '../src/util/secp.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { SimNode } from './SimNetwork.ts';

Deno.test('makeHashContractOutputs: produces beacon + default record pair', () => {
  const blob = new TextEncoder().encode('hello blob');
  const blobHash = Hash.digest(blob);
  const outputs = makeHashContractOutputs(blob);

  assertEquals(outputs.length, 2);
  const beacon = outputs[0];
  assertEquals(beacon.verifier.contract.toHex(), HASH_CONTRACT.toHex());
  assertEquals(Hash.fromBytes(beacon.verifier.params).toHex(), blobHash.toHex());
  assertEquals(beacon.value, 0);
  assertEquals(beacon.body?.length ?? 0, 0);

  const record = outputs[1];
  assertEquals(record.verifier.contract.toHex(), RECORD_CONTRACT.toHex());
  assertEquals(new TextDecoder().decode(record.verifier.params), 'default');
  assert(record.body !== undefined);
  assertEquals(new TextDecoder().decode(record.body!), 'hello blob');
});

Deno.test('makeHashContractOutputs: default record discoverable via findRecordOutput', () => {
  const blob = new Uint8Array([1, 2, 3, 4, 5]);
  const outputs = makeHashContractOutputs(blob);
  const fauxBlock = { outputs } as unknown as Parameters<typeof findRecordOutput>[0];
  const found = findRecordOutput(fauxBlock, 'default');
  assert(found !== undefined);
  assertEquals(found!.body.length, blob.length);
});

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

  const blob = new TextEncoder().encode('the quick brown fox');
  const outputs = makeHashContractOutputs(blob);
  // Self-claim both outputs (own indices 0 and 1 in the extended vector).
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

  // Build outputs with a HASH_CONTRACT beacon that lies about its preimage:
  // beacon claims hash(X), but the 'default' record body is Y.
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

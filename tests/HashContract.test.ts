import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { composeGenesisPacket, HASH_CONTRACT, RECORD_CONTRACT } from '../src/core/Block.ts';
import { hashContract, makeHashContractOutputs } from '../src/contracts/HashContract.ts';
import { findRecordOutput } from '../src/contracts/RecordContract.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { secp } from '../src/util/secp.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';

Deno.test('makeHashContractOutputs: produces beacon + record pair', () => {
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
  assertEquals(record.verifier.params.length, 0); // empty record key
  assert(record.body !== undefined);
  assertEquals(new TextDecoder().decode(record.body!), 'hello blob');
});

Deno.test('makeHashContractOutputs: hash discoverable via findRecordOutput', () => {
  const blob = new Uint8Array([1, 2, 3, 4, 5]);
  const outputs = makeHashContractOutputs(blob);
  // Build a tiny faux block so findRecordOutput can scan it.
  const fauxBlock = { outputs } as unknown as Parameters<typeof findRecordOutput>[0];
  const found = findRecordOutput(fauxBlock, '');
  assert(found !== undefined);
  assertEquals(found!.body.length, blob.length);
  for (let i = 0; i < blob.length; i++) assertEquals(found!.body[i], blob[i]);
});

Deno.test('hashContract.run is a trivial accept', () => {
  let resolved = false;
  hashContract.run({
    mode: 1,
    contractHash: () => Hash.digest('any'),
    contractMetadata: () => {
      throw new Error('unreached');
    },
    params: () => new Uint8Array(32),
    claimAll: () => [],
    claimNext: () => {
      throw new Error('unreached');
    },
    emitOutput: () => {},
    requestBody: () => {
      throw new Error('unreached');
    },
    record: () => {},
    fetch: () => new Uint8Array(0),
    fork: () => {},
    sign: () => {},
    timestamp: () => 0,
    // deno-lint-ignore no-explicit-any
  } as any);
  resolved = true;
  assert(resolved);
});

Deno.test('HashContract: Scaffold auto-registers hashContract for verification', () => {
  const privateKey = secp.utils.randomPrivateKey();
  const publicKey = secp.getPublicKey(privateKey, true);
  const genesis = composeGenesisPacket([makeSignatureOutput(publicKey, 100)]);
  const scaffold = new Scaffold({ genesis, privateKey });
  const contract = scaffold.context.execution.getContract(HASH_CONTRACT);
  assert(contract !== undefined, 'HASH_CONTRACT should be auto-registered');
  assertEquals(contract, hashContract);
});

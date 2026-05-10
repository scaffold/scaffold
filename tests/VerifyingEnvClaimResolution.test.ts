// Pins the contract-env side of the same claim-resolution invariant
// covered by UtxoIndex.test.ts: when a contract calls
// `env.claimNext()` (or the inputs feed any other env method), the
// claim index it sees must resolve through OutputSpaceModule, so
// anchor self-claims and aggregate subtree outputs land on the right
// underlying output.

import { assert, assertEquals } from '@std/assert';
import { withNodeFields } from './testutil/blockNodeFields.ts';

import { PacketType } from '../src/core/Packet.ts';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output } from '../src/core/BlockCreationModule.ts';
import {
  AtomSource,
  AtomType,
  Block,
  BlockStore,
  RECORD_CONTRACT,
  SIGNATURE_CONTRACT,
  makeBlockStoreOutputSpace,
  resolveClaimToOutput,
} from '../src/core/Block.ts';
import { VerifyingEnv } from '../src/core/VerifyingEnv.ts';
import type { VerifyingEnvProvider } from '../src/core/ContractEnv.ts';

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeBlock(opts: {
  name: string;
  anchor?: Hash;
  outputs?: Output[];
  claimIndices?: number[];
}): Block {
  const claimIndices = (opts.claimIndices ?? []).slice().sort((a, b) => a - b);
  return withNodeFields({
    hash: h(opts.name),
    anchor: opts.anchor ?? ZERO_HASH,
    outputs: opts.outputs ?? [],
    claimIndices,
    refs: [],
    aggregates: [],
    declaredWeight: 1,
    timestamp: 0,
    receivedAt: 0,
    type: AtomType.Block,
    packetType: PacketType.JsonUnsignedBlock,
    raw: new Uint8Array(0),
    fromConnections: [],
    toConnections: new Set(),
    source: AtomSource.Local,
  });
}

function sigOut(label: string, value: number, data = enc(label)): Output {
  return {
    verifier: { contract: SIGNATURE_CONTRACT, params: enc(label) },
    value,
    data,
  };
}

function recordOut(key: string): Output {
  return {
    verifier: { contract: RECORD_CONTRACT, params: enc(key) },
    value: 0,
    data: enc(`record-data-${key}`),
  };
}

function makeProvider(store: BlockStore): VerifyingEnvProvider<Block> {
  const space = makeBlockStoreOutputSpace(store);
  return {
    getBlock: (hash) => store.get(hash),
    getOutputs: (b) => b.outputs,
    getClaims: (b) => b.claimIndices,
    getRefs: (b) => b.refs,
    resolveClaim: (b, i) => resolveClaimToOutput(b, i, store, space)?.output,
  };
}

Deno.test('VerifyingEnv.claimNext resolves through anchor self-claims', () => {
  // Genesis ──> A ──> B(this verifier)
  //
  // A self-claims its RECORD output at index 1. B's external claim
  // index 1 (after own_count=0) addresses output_space(A)[1] = a1, NOT
  // the legacy walk's `[a0, RECORD, a1, ...][1]` = RECORD.
  //
  // The contract under test calls claimNext() expecting a SIG
  // output for label "a1". If the env resolved into RECORD instead,
  // the input wouldn't match and the call would throw.

  const store = new BlockStore();
  const genesis = makeBlock({
    name: 'genesis-env',
    outputs: [sigOut('g0', 100)],
  });
  const a = makeBlock({
    name: 'A-env',
    anchor: genesis.hash,
    outputs: [sigOut('a0', 50), recordOut('meta'), sigOut('a1', 7)],
    claimIndices: [1], // self-claim RECORD
  });
  const b = makeBlock({
    name: 'B-env',
    anchor: a.hash,
    outputs: [],
    claimIndices: [1], // ext idx 1 -- output_space(A)[1] = a1
  });
  store.put(genesis);
  store.put(a);
  store.put(b);

  const provider = makeProvider(store);
  // Run the SIGNATURE_CONTRACT verifier with params = "a1": it should
  // find a single matching input from B's claims via the env.
  const env = new VerifyingEnv<Block>({
    contractHash: SIGNATURE_CONTRACT,
    params: enc('a1'),
    block: b,
    outputs: b.outputs,
    claimIndices: b.claimIndices,
    refs: b.refs,
    provider,
  });

  const inputs = env.claimAll();
  assertEquals(inputs.length, 1, 'exactly one input matching SIG/a1');
  assertEquals(inputs[0].value, 7, 'value must be a1.value');
  assertEquals(
    new TextDecoder().decode(inputs[0].verifier.params),
    'a1',
    'verifier.params must be a1, never RECORD/meta',
  );
});

Deno.test('VerifyingEnv.claimNext rejects when claim resolves to a foreign verifier', () => {
  // Same fixture, but the contract under test verifies SIG/a0 -- B
  // claims a1, not a0, so claimNext must yield nothing.
  const store = new BlockStore();
  const genesis = makeBlock({ name: 'genesis-env-2', outputs: [sigOut('g0', 100)] });
  const a = makeBlock({
    name: 'A-env-2',
    anchor: genesis.hash,
    outputs: [sigOut('a0', 50), recordOut('meta'), sigOut('a1', 7)],
    claimIndices: [1],
  });
  const b = makeBlock({
    name: 'B-env-2',
    anchor: a.hash,
    outputs: [],
    claimIndices: [1],
  });
  store.put(genesis);
  store.put(a);
  store.put(b);

  const env = new VerifyingEnv<Block>({
    contractHash: SIGNATURE_CONTRACT,
    params: enc('a0'),
    block: b,
    outputs: b.outputs,
    claimIndices: b.claimIndices,
    refs: b.refs,
    provider: makeProvider(store),
  });

  assertEquals(env.claimAll().length, 0);
});

Deno.test('Block.resolveClaimToOutput returns producer + output for valid index', () => {
  const store = new BlockStore();
  const genesis = makeBlock({ name: 'genesis-rcto', outputs: [sigOut('g', 1)] });
  const a = makeBlock({
    name: 'A-rcto',
    anchor: genesis.hash,
    outputs: [sigOut('a0', 9)],
  });
  store.put(genesis);
  store.put(a);

  // Claim index 0 in A's extended vector is A's own output 0 (a0).
  const own = resolveClaimToOutput(a, 0, store);
  assert(own, 'self-claim index 0 must resolve');
  assertEquals(own.output.value, 9);
  assertEquals(own.outputIndex, 0);

  // Claim index 1 in A's extended vector is output_space(genesis)[0] = g.
  const ext = resolveClaimToOutput(a, 1, store);
  assert(ext, 'external claim index 1 must resolve');
  assertEquals(ext.output.value, 1);
  assertEquals(ext.outputIndex, 0);

  // Out of range returns undefined, not a stale slot.
  assertEquals(resolveClaimToOutput(a, 99, store), undefined);
});

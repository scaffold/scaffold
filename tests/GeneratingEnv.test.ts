import { assert, assertEquals, assertRejects } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output, Verifier } from '../src/core/BlockCreationModule.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput } from '../src/contracts/RecordContract.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import {
  type AvailableInput,
  type ContractEnv,
  ContractRejection,
  type GeneratingEnvProvider,
  type Input,
} from '../src/core/ContractEnv.ts';
import { GeneratingEnv } from '../src/core/GeneratingEnv.ts';
import { VerifyingEnv } from '../src/core/VerifyingEnv.ts';
import type { MaybePromise } from '../src/util/MaybePromise.ts';

// -- Test block type -----------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claimIndices: number[];
  refs: Hash[];
}

// -- Helpers -------------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

class TestGenProvider implements GeneratingEnvProvider<TestBlock> {
  readonly blocks = new Map<string, TestBlock>();
  private readonly _availableInputs = new Map<string, AvailableInput[]>();
  private readonly _blocksClaiming = new Map<string, Hash>();

  addBlock(block: TestBlock): void {
    this.blocks.set(block.hash.toHex(), block);
  }

  setAvailableInputs(verifier: Verifier, inputs: AvailableInput[]): void {
    this._availableInputs.set(
      verifier.contract.toHex() + ':' + Array.from(verifier.params).join(','),
      inputs,
    );
  }

  setBlockClaiming(verifier: Verifier, blockHash: Hash): void {
    this._blocksClaiming.set(
      verifier.contract.toHex() + ':' + Array.from(verifier.params).join(','),
      blockHash,
    );
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toHex());
  }

  getOutputs(block: TestBlock): Output[] {
    return block.outputs;
  }

  getClaims(block: TestBlock): number[] {
    return block.claimIndices;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  resolveClaim(block: TestBlock, claimIndex: number): Output | undefined {
    if (claimIndex < block.outputs.length) return block.outputs[claimIndex];
    if (Hash.equals(block.anchor, ZERO_HASH)) return undefined;
    const anchor = this.getBlock(block.anchor);
    if (!anchor) return undefined;
    return anchor.outputs[claimIndex - block.outputs.length];
  }

  findInputs(verifier: Verifier): MaybePromise<AvailableInput[]> {
    const key = verifier.contract.toHex() + ':' + Array.from(verifier.params).join(',');
    return this._availableInputs.get(key) ?? [];
  }

  findBlockClaiming(verifier: Verifier): MaybePromise<Hash | undefined> {
    const key = verifier.contract.toHex() + ':' + Array.from(verifier.params).join(',');
    return this._blocksClaiming.get(key);
  }

  /** Handler chain for requestBody. Tests can override by assigning _resolveGetOutput. */
  _resolveGetOutput:
    | ((
      runningContract: Hash,
      runningParams: Uint8Array,
      outputVerifier: Verifier,
    ) => Promise<{ value: number; body: Uint8Array } | null>)
    | null = null;

  resolveGetOutput(
    runningContract: Hash,
    runningParams: Uint8Array,
    outputVerifier: Verifier,
  ): Promise<{ value: number; body: Uint8Array } | null> {
    if (this._resolveGetOutput) {
      return this._resolveGetOutput(runningContract, runningParams, outputVerifier);
    }
    return Promise.resolve(null);
  }
}

function makeGenEnv(opts?: {
  contractHash?: Hash;
  params?: Uint8Array;
  provider?: TestGenProvider;
}): { env: GeneratingEnv<TestBlock>; provider: TestGenProvider } {
  const provider = opts?.provider ?? new TestGenProvider();
  const env = new GeneratingEnv({
    contractHash: opts?.contractHash ?? h('test-contract'),
    params: opts?.params ?? new Uint8Array(0),
    provider,
  });
  return { env, provider };
}

// -- Tests: identity -----------------------------------------------

Deno.test('GeneratingEnv: mode is Generation', () => {
  const { env } = makeGenEnv();
  assertEquals(env.mode, ExecutionMode.Generation);
});

Deno.test('GeneratingEnv: contractHash and params', () => {
  const contractHash = h('my-contract');
  const params = enc('my-params');
  const { env } = makeGenEnv({ contractHash, params });
  assert(Hash.equals(env.contractHash(), contractHash));
  assertEquals(env.params(), params);
});

// -- Tests: record ------------------------------------------

Deno.test('GeneratingEnv: record creates a result output', () => {
  const { env } = makeGenEnv();
  env.record(enc('state'), enc('value'));

  const outputs = env.getAllOutputs();
  assertEquals(outputs.length, 1);
  assert(Hash.equals(outputs[0].verifier.contract, RECORD_CONTRACT));
  assertEquals(outputs[0].verifier.params, enc('state'));
  assertEquals(outputs[0].body, enc('value'));
  assertEquals(outputs[0].value, 0);
});

Deno.test('GeneratingEnv: multiple record calls', () => {
  const { env } = makeGenEnv();
  env.record(enc('a'), enc('1'));
  env.record(enc('b'), enc('2'));

  const outputs = env.getAllOutputs();
  assertEquals(outputs.length, 2);
});

// -- Tests: emitOutput ------------------------------------------

Deno.test('GeneratingEnv: emitOutput adds output to list', () => {
  const { env } = makeGenEnv();
  const verifier: Verifier = { contract: h('pay'), params: enc('pk') };
  env.emitOutput(verifier, 42, enc('data'));

  const outputs = env.getAllOutputs();
  assertEquals(outputs.length, 1);
  assert(Hash.equals(outputs[0].verifier.contract, verifier.contract));
  assertEquals(outputs[0].value, 42);
  assertEquals(outputs[0].body, enc('data'));
});

Deno.test('GeneratingEnv: emitOutput defaults data to empty', () => {
  const { env } = makeGenEnv();
  env.emitOutput({ contract: h('x'), params: new Uint8Array(0) }, 10);
  assertEquals(env.getAllOutputs()[0].body, new Uint8Array(0));
});

Deno.test('GeneratingEnv: interleaved record and emitOutput preserve call order', () => {
  const { env } = makeGenEnv();
  env.emitOutput({ contract: h('pay'), params: enc('pk') }, 5, enc('a'));
  env.record(enc('k1'), enc('v1'));
  env.emitOutput({ contract: h('pay'), params: enc('pk') }, 3, enc('b'));
  env.record(enc('k2'), enc('v2'));

  const slots = env.getGeneratedOutputSlots();
  assertEquals(slots.length, 4);
  assertEquals(slots.every((s) => s.origin === 'require'), true);
  assertEquals(slots[0].output.body, enc('a'));
  assert(Hash.equals(slots[1].output.verifier.contract, RECORD_CONTRACT));
  assertEquals(slots[1].output.verifier.params, enc('k1'));
  assertEquals(slots[2].output.body, enc('b'));
  assertEquals(slots[3].output.verifier.params, enc('k2'));
});

// -- Tests: claimAll ------------------------------------------

Deno.test('GeneratingEnv: claimAll queries provider', () => {
  const provider = new TestGenProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const available: AvailableInput[] = [
    { verifier, value: 10, body: enc('move1'), isSelfClaim: false, block: h('b1'), outputIndex: 0 },
    { verifier, value: 20, body: enc('move2'), isSelfClaim: false, block: h('b2'), outputIndex: 1 },
  ];
  provider.setAvailableInputs(verifier, available);

  const { env } = makeGenEnv({ contractHash, params, provider });
  const result = env.claimAll() as Input[];
  assertEquals(result.length, 2);
  assertEquals(result[0].value, 10);
  assertEquals(result[1].value, 20);

  // Resolved claims track provenance (value derived from store on demand)
  const claims = env.getClaims();
  assertEquals(claims.length, 2);
  assert(Hash.equals(claims[0].producer, h('b1')));
  assertEquals(claims[0].outputIndex, 0);
  assert(Hash.equals(claims[1].producer, h('b2')));
  assertEquals(claims[1].outputIndex, 1);
});

Deno.test('GeneratingEnv: claimAll returns empty when no inputs', () => {
  const { env } = makeGenEnv();
  assertEquals(env.claimAll(), []);
});

Deno.test('GeneratingEnv: fetch skips data-less record outputs', async () => {
  const provider = new TestGenProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const refBlock: TestBlock = {
    hash: h('ref-block'),
    anchor: ZERO_HASH,
    outputs: [
      // Same contract+params as the 'state' record key, but no data --
      // fetch must skip it and use the real record below.
      { verifier: { contract: RECORD_CONTRACT, params: enc('state') }, value: 0 },
      makeRecordOutput('state', enc('S0')),
    ],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(refBlock);
  provider.setBlockClaiming(gameVerifier, refBlock.hash);

  const { env } = makeGenEnv({ provider });
  const result = await env.fetch(gameVerifier, enc('state'));
  assertEquals(result, enc('S0'));
});

// -- Tests: claimNext -------------------------------------------

Deno.test('GeneratingEnv: claimNext returns first available input', () => {
  const provider = new TestGenProvider();
  const contractHash = h('game');
  const params = enc('cfg');
  const verifier: Verifier = { contract: contractHash, params };

  const available: AvailableInput[] = [
    { verifier, value: 5, body: enc('data'), isSelfClaim: false, block: h('b1'), outputIndex: 2 },
  ];
  provider.setAvailableInputs(verifier, available);

  const { env } = makeGenEnv({ contractHash, params, provider });
  const input = env.claimNext() as Input;
  assertEquals(input.value, 5);
  assertEquals(input.body, enc('data'));

  // Resolved claim tracks provenance (value derived from store on demand)
  const claims = env.getClaims();
  assertEquals(claims.length, 1);
  assert(Hash.equals(claims[0].producer, h('b1')));
  assertEquals(claims[0].outputIndex, 2);
});

Deno.test('GeneratingEnv: claimNext throws when no inputs', () => {
  const { env } = makeGenEnv();
  try {
    env.claimNext();
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e instanceof ContractRejection);
  }
});

// -- Tests: fetch --------------------------------------------------

Deno.test('GeneratingEnv: fetch queries provider and records ref', () => {
  const provider = new TestGenProvider();
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  const refBlock: TestBlock = {
    hash: h('ref-block'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('S0'))],
    claimIndices: [],
    refs: [],
  };
  provider.addBlock(refBlock);
  provider.setBlockClaiming(gameVerifier, refBlock.hash);

  const { env } = makeGenEnv({ provider });
  const result = env.fetch(gameVerifier, enc('state'));
  assertEquals(result, enc('S0'));

  const refs = env.getGeneratedRefs();
  assertEquals(refs.length, 1);
  assert(Hash.equals(refs[0], refBlock.hash));
});

Deno.test('GeneratingEnv: fetch throws when no block claims verifier', () => {
  const { env } = makeGenEnv();
  try {
    env.fetch({ contract: h('x'), params: new Uint8Array(0) }, enc('key'));
    assert(false, 'should have thrown');
  } catch (e) {
    assert(e instanceof ContractRejection);
  }
});

// -- Tests: getAllOutputs ------------------------------------------

Deno.test('GeneratingEnv: getAllOutputs returns results then regular outputs', () => {
  const { env } = makeGenEnv();
  env.record(enc('state'), enc('val'));
  env.emitOutput({ contract: h('pay'), params: enc('pk') }, 50);

  const all = env.getAllOutputs();
  assertEquals(all.length, 2);
  assert(Hash.equals(all[0].verifier.contract, RECORD_CONTRACT));
  assert(Hash.equals(all[1].verifier.contract, h('pay')));
});

// -- Tests: round-trip (same contract works in both modes) ---------

Deno.test('GeneratingEnv: round-trip -- same contract works in generate and verify', () => {
  const gameVerifier: Verifier = { contract: h('game'), params: enc('cfg') };

  // A contract that reads previous state, computes new state, and requires outputs
  const contract = (env: ContractEnv) => {
    const prevState = env.fetch(gameVerifier, enc('state'));
    // In sync context, prevState is Uint8Array directly
    const state = prevState as Uint8Array;
    const newState = new Uint8Array([...state, 1]);

    env.record(enc('state'), newState);
    env.emitOutput(
      { contract: h('sig'), params: enc('creator') },
      10,
      new Uint8Array(0),
    );
  };

  // --- Generation ---
  const genProvider = new TestGenProvider();
  const refBlock: TestBlock = {
    hash: h('prev'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('state', enc('S'))],
    claimIndices: [],
    refs: [],
  };
  genProvider.addBlock(refBlock);
  genProvider.setBlockClaiming(gameVerifier, refBlock.hash);

  const genEnv = new GeneratingEnv<TestBlock>({
    contractHash: h('game'),
    params: enc('cfg'),
    provider: genProvider,
  });
  contract(genEnv);

  const generatedOutputs = genEnv.getAllOutputs();
  const generatedRefs = genEnv.getGeneratedRefs();

  // --- Verification ---
  // Build a block from the generated outputs
  const block: TestBlock = {
    hash: h('new-block'),
    anchor: ZERO_HASH,
    outputs: generatedOutputs,
    claimIndices: [],
    refs: generatedRefs,
  };

  // Add the ref block to verification provider too
  const verProvider = new TestGenProvider();
  verProvider.addBlock(refBlock);
  verProvider.addBlock(block);

  // Make the ref block look like it claims the game verifier
  const anchorForRef: TestBlock = {
    hash: h('ref-anchor'),
    anchor: ZERO_HASH,
    outputs: [{ verifier: gameVerifier, value: 0, body: new Uint8Array(0) }],
    claimIndices: [],
    refs: [],
  };
  verProvider.addBlock(anchorForRef);

  // Update refBlock to have claims for verification
  const refBlockWithClaims: TestBlock = {
    ...refBlock,
    anchor: anchorForRef.hash,
    claimIndices: [1], // claims the game output from anchor
  };
  verProvider.blocks.set(refBlock.hash.toHex(), refBlockWithClaims);

  const verEnv = new VerifyingEnv<TestBlock>({
    contractHash: h('game'),
    params: enc('cfg'),
    block,
    outputs: block.outputs,
    claimIndices: block.claimIndices,
    refs: block.refs,
    provider: verProvider,
  });

  // Should not throw -- verification passes with the same contract
  contract(verEnv);
});

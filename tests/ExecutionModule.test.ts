import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { createSelfClaimedOutput, SELF_CONTRACT, SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import {
  ContractFn,
  ExecutionMode,
  ExecutionModule,
  ExecutionProvider,
  ExecutionResult,
  HostContext,
} from '../src/core/ExecutionModule.ts';

// -- Test block type -------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claims: number[];
  refs: Hash[];
}

// -- Test helpers ----------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeOutput(
  contractName: string,
  params: Uint8Array,
  value: number,
  detail: Uint8Array,
): Output {
  return {
    verifier: { contract: h(contractName), params },
    value,
    detail,
  };
}

class TestProvider implements ExecutionProvider<TestBlock> {
  readonly blocks = new Map<string, TestBlock>();

  addBlock(block: TestBlock): void {
    this.blocks.set(block.hash.toHex(), block);
  }

  getBlock(hash: Hash): TestBlock | undefined {
    return this.blocks.get(hash.toHex());
  }

  getOutputs(block: TestBlock): Output[] {
    return block.outputs;
  }

  getRefs(block: TestBlock): Hash[] {
    return block.refs;
  }

  getClaims(block: TestBlock): number[] {
    return block.claims;
  }

  getAnchor(block: TestBlock): Hash {
    return block.anchor;
  }

  getExtendedOutputs(block: TestBlock): Output[] {
    // For tests, extended outputs = own outputs + anchor's outputs
    const result: Output[] = [...block.outputs];
    if (Hash.equals(block.anchor, ZERO_HASH)) return result;
    const anchor = this.getBlock(block.anchor);
    if (anchor) {
      result.push(...anchor.outputs);
    }
    return result;
  }
}

function setup(): { provider: TestProvider; module: ExecutionModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new ExecutionModule(provider);
  return { provider, module };
}

// -- Tests -----------------------------------------------------------

Deno.test('ExecutionModule: block with no claims is trivially valid', () => {
  const { provider, module } = setup();

  const block: TestBlock = {
    hash: h('block-1'),
    anchor: ZERO_HASH,
    outputs: [makeOutput('some-contract', new Uint8Array(0), 10, enc('data'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: self-claimed outputs are trivially valid', () => {
  const { provider, module } = setup();

  const selfOutput = createSelfClaimedOutput('state', enc('value'));
  const block: TestBlock = {
    hash: h('self-claim-block'),
    anchor: ZERO_HASH,
    outputs: [selfOutput],
    claims: [0], // claiming own self output
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: signature contract — accept when params match pubkey', () => {
  const { provider, module } = setup();

  const pubkey = enc('eagle-pubkey');
  const sigContract = h('sig-contract');

  // Register a signature-checking contract
  const sigFn: ContractFn = (ctx: HostContext) => {
    ctx.requireSignature(ctx.currentParams);
    ctx.accept();
  };
  module.registerContract(sigContract, sigFn);

  // Anchor block with a signature-locked output
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: sigContract, params: pubkey },
      value: 100,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block that claims the anchor's output
  const block: TestBlock = {
    hash: h('claimer'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0], // claims extended output index 0 → anchor's output[0]
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: signature contract — reject when pubkey mismatch', () => {
  const { provider, module } = setup();

  const sigContract = h('sig-contract');

  const sigFn: ContractFn = (ctx: HostContext) => {
    // Contract checks that params match a specific pubkey
    ctx.requireSignature(enc('expected-pubkey'));
    if (!ctx.result) ctx.accept();
  };
  module.registerContract(sigContract, sigFn);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: sigContract, params: enc('wrong-pubkey') },
      value: 50,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('claimer'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
});

Deno.test('ExecutionModule: self-claim verification — setData checks match', () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');

  // Contract that verifies self-claimed state
  const gameFn: ContractFn = (ctx: HostContext) => {
    ctx.setData('state', enc('valid-state'));
    if (!ctx.result) ctx.accept();
  };
  module.registerContract(gameContract, gameFn);

  // Anchor with a game output to claim
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: gameContract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block that claims anchor's output and has matching self-claimed data
  const block: TestBlock = {
    hash: h('game-block'),
    anchor: anchor.hash,
    outputs: [
      createSelfClaimedOutput('state', enc('valid-state')),
    ],
    claims: [1], // claims extended index 1 → anchor's output[0]
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: self-claim verification — setData rejects wrong value', () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');

  const gameFn: ContractFn = (ctx: HostContext) => {
    ctx.setData('state', enc('expected-state'));
    if (!ctx.result) ctx.accept();
  };
  module.registerContract(gameContract, gameFn);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: gameContract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block has WRONG self-claimed data
  const block: TestBlock = {
    hash: h('bad-block'),
    anchor: anchor.hash,
    outputs: [
      createSelfClaimedOutput('state', enc('wrong-state')),
    ],
    claims: [1],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('wrong value'));
  }
});

Deno.test('ExecutionModule: cross-block reference — reads previous state', () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');

  // Contract reads state from ref[0] and verifies new state is correct
  const gameFn: ContractFn = (ctx: HostContext) => {
    const outputCount = ctx.refOutputCount(0);
    let prevState: Uint8Array | undefined;
    for (let i = 0; i < outputCount; i++) {
      const verifier = ctx.refOutputVerifier(0, i);
      if (verifier && Hash.equals(verifier.contract, SELF_CONTRACT)) {
        prevState = ctx.refOutputDetail(0, i);
        break;
      }
    }
    if (!prevState) {
      ctx.reject('no previous state found');
      return;
    }

    // Verify new state is "prev + 1" (simplified check)
    const prev = new TextDecoder().decode(prevState);
    ctx.setData('state', enc(`${prev}+1`));
    if (!ctx.result) ctx.accept();
  };
  module.registerContract(gameContract, gameFn);

  // Previous block with self-claimed state
  const prevBlock: TestBlock = {
    hash: h('prev-block'),
    anchor: ZERO_HASH,
    outputs: [createSelfClaimedOutput('state', enc('S0'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(prevBlock);

  // Anchor with game output to claim
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: gameContract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // New block referencing prev-block and claiming anchor's game output
  const block: TestBlock = {
    hash: h('new-block'),
    anchor: anchor.hash,
    outputs: [createSelfClaimedOutput('state', enc('S0+1'))],
    claims: [1], // claims anchor's output[0]
    refs: [prevBlock.hash],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: addOutput checks matching output exists', () => {
  const { provider, module } = setup();

  const contract = h('test-contract');
  const targetContract = h('target-contract');
  const targetParams = enc('target-params');

  const fn: ContractFn = (ctx: HostContext) => {
    ctx.addOutput(targetContract, targetParams, 42, enc('payload'));
    if (!ctx.result) ctx.accept();
  };
  module.registerContract(contract, fn);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block WITH the required output
  const goodBlock: TestBlock = {
    hash: h('good-block'),
    anchor: anchor.hash,
    outputs: [{
      verifier: { contract: targetContract, params: targetParams },
      value: 42,
      detail: enc('payload'),
    }],
    claims: [1],
    refs: [],
  };
  provider.addBlock(goodBlock);

  const result = module.verifyBlock(goodBlock.hash);
  assert(result.accepted);

  // Block WITHOUT the required output
  const badBlock: TestBlock = {
    hash: h('bad-block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(badBlock);

  const badResult = module.verifyBlock(badBlock.hash);
  assert(!badResult.accepted);
  if (!badResult.accepted) {
    assert(badResult.reason.includes('required output not found'));
  }
});

Deno.test('ExecutionModule: contract calls reject() → block invalid', () => {
  const { provider, module } = setup();

  const contract = h('always-reject');

  module.registerContract(contract, (ctx) => {
    ctx.reject('nope');
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('rejected-block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assertEquals(result.reason, 'nope');
  }
});

Deno.test('ExecutionModule: multiple claimed outputs from different contracts — all must accept', () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, (ctx) => ctx.accept());
  module.registerContract(contractB, (ctx) => ctx.accept());

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        detail: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        detail: new Uint8Array(0),
      },
    ],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('multi-claim'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0, 1], // claims both anchor outputs
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: multiple contracts — one rejects → block invalid', () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, (ctx) => ctx.accept());
  module.registerContract(contractB, (ctx) => ctx.reject('contract B rejects'));

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        detail: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        detail: new Uint8Array(0),
      },
    ],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('multi-claim'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0, 1],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
});

Deno.test('ExecutionModule: contract not found → block invalid', () => {
  const { provider, module } = setup();

  const unknownContract = h('unknown-contract');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: unknownContract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('no-contract-block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('contract not found'));
  }
});

Deno.test('ExecutionModule: contract does not call accept/reject → invalid', () => {
  const { provider, module } = setup();

  const contract = h('silent-contract');
  module.registerContract(contract, (_ctx) => {
    // does nothing
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('silent-block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('did not call accept'));
  }
});

Deno.test('ExecutionModule: contract throws → block invalid', () => {
  const { provider, module } = setup();

  const contract = h('throwing-contract');
  module.registerContract(contract, (_ctx) => {
    throw new Error('boom');
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('throws-block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('contract threw'));
  }
});

Deno.test('ExecutionModule: verifyClaim verifies a single claim', () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, (ctx) => ctx.accept());
  module.registerContract(contractB, (ctx) => ctx.reject('B rejects'));

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        detail: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        detail: new Uint8Array(0),
      },
    ],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0, 1],
    refs: [],
  };
  provider.addBlock(block);

  // Claim 0 (contractA) should accept
  const result0 = module.verifyClaim(block.hash, 0);
  assert(result0.accepted);

  // Claim 1 (contractB) should reject
  const result1 = module.verifyClaim(block.hash, 1);
  assert(!result1.accepted);
});

Deno.test('ExecutionModule: verifyClaim for self-claimed output is trivially valid', () => {
  const { provider, module } = setup();

  const block: TestBlock = {
    hash: h('block'),
    anchor: ZERO_HASH,
    outputs: [createSelfClaimedOutput('key', enc('val'))],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = module.verifyClaim(block.hash, 0);
  assert(result.accepted);
});

Deno.test('ExecutionModule: block not found returns error', () => {
  const { module } = setup();

  const result = module.verifyBlock(h('nonexistent'));
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('block not found'));
  }
});

Deno.test('ExecutionModule: HostContext mode and contract info', () => {
  const { provider, module } = setup();

  const contract = h('info-contract');
  let capturedMode: ExecutionMode | undefined;
  let capturedContract: Hash | undefined;
  let capturedParams: Uint8Array | undefined;

  module.registerContract(contract, (ctx) => {
    capturedMode = ctx.mode;
    capturedContract = ctx.currentContract;
    capturedParams = ctx.currentParams;
    ctx.accept();
  });

  const params = enc('my-params');
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  module.verifyBlock(block.hash);

  assertEquals(capturedMode, ExecutionMode.Verification);
  assert(capturedContract !== undefined);
  assert(Hash.equals(capturedContract!, contract));
  assertEquals(capturedParams, params);
});

Deno.test('ExecutionModule: HostContext claimedOutputCount and claimedOutputDetail', () => {
  const { provider, module } = setup();

  const contract = h('claim-reader');
  let claimCount = 0;
  let detail0: Uint8Array | undefined;

  module.registerContract(contract, (ctx) => {
    claimCount = ctx.claimedOutputCount();
    detail0 = ctx.claimedOutputDetail(0);
    ctx.accept();
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: enc('claimed-data'),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  module.verifyBlock(block.hash);

  assertEquals(claimCount, 1);
  assertEquals(detail0, enc('claimed-data'));
});

Deno.test('ExecutionModule: HostContext ref functions', () => {
  const { provider, module } = setup();

  const contract = h('ref-reader');
  let refCountVal = 0;
  let refOutputCountVal = 0;
  let refDetail: Uint8Array | undefined;

  module.registerContract(contract, (ctx) => {
    refCountVal = ctx.refCount();
    refOutputCountVal = ctx.refOutputCount(0);
    refDetail = ctx.refOutputDetail(0, 0);
    ctx.accept();
  });

  const refBlock: TestBlock = {
    hash: h('ref-block'),
    anchor: ZERO_HASH,
    outputs: [createSelfClaimedOutput('data', enc('ref-data'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(refBlock);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      detail: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  const block: TestBlock = {
    hash: h('block'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0],
    refs: [refBlock.hash],
  };
  provider.addBlock(block);

  module.verifyBlock(block.hash);

  assertEquals(refCountVal, 1);
  assertEquals(refOutputCountVal, 1);
  assertEquals(refDetail, enc('ref-data'));
});

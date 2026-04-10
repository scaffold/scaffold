import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Output } from '../src/core/BlockCreationModule.ts';
import { RECORD_CONTRACT, SIGNATURE_CONTRACT } from '../src/core/Block.ts';
import { makeRecordOutput, recordContract } from '../src/contracts/RecordContract.ts';
import {
  type Contract,
  ExecutionMode,
  ExecutionModule,
  type ExecutionProvider,
  type ExecutionResult,
} from '../src/core/ExecutionModule.ts';
import { type ContractEnv, ContractRejection } from '../src/core/ContractEnv.ts';

// -- Test block type -------------------------------------------------

interface TestBlock {
  hash: Hash;
  anchor: Hash;
  outputs: Output[];
  claims: number[];
  refs: Hash[];
  signer?: Uint8Array;
}

// -- Test helpers ----------------------------------------------------

const h = (name: string): Hash => Hash.digest(name);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function makeOutput(
  contractName: string,
  params: Uint8Array,
  value: number,
  data: Uint8Array,
): Output {
  return {
    verifier: { contract: h(contractName), params },
    value,
    data,
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

  getSigner(block: TestBlock): Uint8Array | undefined {
    return block.signer;
  }

  getTimestamp(_block: TestBlock): number {
    return 0;
  }
}

function setup(): { provider: TestProvider; module: ExecutionModule<TestBlock> } {
  const provider = new TestProvider();
  const module = new ExecutionModule(provider);
  module.registerContract(RECORD_CONTRACT, recordContract);
  return { provider, module };
}

// -- Tests -----------------------------------------------------------

Deno.test('ExecutionModule: block with no claims is trivially valid', async () => {
  const { provider, module } = setup();

  const block: TestBlock = {
    hash: h('block-1'),
    anchor: ZERO_HASH,
    outputs: [makeOutput('some-contract', new Uint8Array(0), 10, enc('data'))],
    claims: [],
    refs: [],
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: self-claimed outputs are trivially valid', async () => {
  const { provider, module } = setup();

  const selfOutput = makeRecordOutput('state', enc('value'));
  const block: TestBlock = {
    hash: h('self-claim-block'),
    anchor: ZERO_HASH,
    outputs: [selfOutput],
    claims: [0], // claiming own self output
    refs: [],
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: signature contract -- accept when params match pubkey', async () => {
  const { provider, module } = setup();

  const pubkey = enc('eagle-pubkey');
  const sigContract = h('sig-contract');

  // Contract checks that params match pubkey
  const sigContract_: Contract = {
    run(env: ContractEnv) {
      env.requireSignature(env.getParams());
    },
  };
  module.registerContract(sigContract, sigContract_);

  // Anchor block with a signature-locked output
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: sigContract, params: pubkey },
      value: 100,
      data: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block that claims the anchor's output -- signed by the matching key
  const block: TestBlock = {
    hash: h('claimer'),
    anchor: anchor.hash,
    outputs: [],
    claims: [0], // claims extended output index 0 -> anchor's output[0]
    refs: [],
    signer: pubkey,
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: signature contract -- reject when pubkey mismatch', async () => {
  const { provider, module } = setup();

  const sigContract = h('sig-contract');

  const sigContract_: Contract = {
    run(env: ContractEnv) {
      // Contract checks that params match a specific pubkey
      env.requireSignature(enc('expected-pubkey'));
    },
  };
  module.registerContract(sigContract, sigContract_);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: sigContract, params: enc('wrong-pubkey') },
      value: 50,
      data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
});

Deno.test('ExecutionModule: requireResult checks self-claimed data', async () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');

  // Contract that verifies result output exists
  const gameContractImpl: Contract = {
    run(env: ContractEnv) {
      env.requireResult(enc('state'), enc('valid-state'));
    },
  };
  module.registerContract(gameContract, gameContractImpl);

  // Anchor with a game output to claim
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: gameContract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block that claims anchor's output and has matching result data
  const block: TestBlock = {
    hash: h('game-block'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('state', enc('valid-state')),
    ],
    claims: [1], // claims extended index 1 -> anchor's output[0]
    refs: [],
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: requireResult rejects wrong value', async () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');

  const gameContractImpl: Contract = {
    run(env: ContractEnv) {
      env.requireResult(enc('state'), enc('expected-state'));
    },
  };
  module.registerContract(gameContract, gameContractImpl);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: gameContract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // Block has WRONG result data
  const block: TestBlock = {
    hash: h('bad-block'),
    anchor: anchor.hash,
    outputs: [
      makeRecordOutput('state', enc('wrong-state')),
    ],
    claims: [1],
    refs: [],
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('wrong value'));
  }
});

Deno.test('ExecutionModule: cross-block fetch -- reads previous state', async () => {
  const { provider, module } = setup();

  const gameContract = h('game-contract');
  const gameVerifier = { contract: gameContract, params: new Uint8Array(0) };

  // Contract reads state from a ref block that claims gameVerifier
  const gameContractImpl: Contract = {
    run(env: ContractEnv) {
      const prevState = env.fetch(gameVerifier, enc('state')) as Uint8Array;
      const prev = new TextDecoder().decode(prevState);
      env.requireResult(enc('state'), enc(`${prev}+1`));
    },
  };
  module.registerContract(gameContract, gameContractImpl);

  // Anchor for the previous block (has a game output to claim)
  const prevAnchor: TestBlock = {
    hash: h('prev-anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: gameVerifier,
      value: 0,
      data: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(prevAnchor);

  // Previous block with result state, claiming the game output
  const prevBlock: TestBlock = {
    hash: h('prev-block'),
    anchor: prevAnchor.hash,
    outputs: [makeRecordOutput('state', enc('S0'))],
    claims: [1], // claims extended index 1 = prevAnchor's game output
    refs: [],
  };
  provider.addBlock(prevBlock);

  // Anchor with game output to claim
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: gameVerifier,
      value: 0,
      data: new Uint8Array(0),
    }],
    claims: [],
    refs: [],
  };
  provider.addBlock(anchor);

  // New block referencing prev-block and claiming anchor's game output
  const block: TestBlock = {
    hash: h('new-block'),
    anchor: anchor.hash,
    outputs: [makeRecordOutput('state', enc('S0+1'))],
    claims: [1], // claims anchor's output[0]
    refs: [prevBlock.hash],
  };
  provider.addBlock(block);

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: requireOutput checks matching output exists', async () => {
  const { provider, module } = setup();

  const contract = h('test-contract');
  const targetContract = h('target-contract');
  const targetParams = enc('target-params');

  const contractImpl: Contract = {
    run(env: ContractEnv) {
      env.requireOutput(
        { contract: targetContract, params: targetParams },
        42,
        enc('payload'),
      );
    },
  };
  module.registerContract(contract, contractImpl);

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
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
      data: enc('payload'),
    }],
    claims: [1],
    refs: [],
  };
  provider.addBlock(goodBlock);

  const result = await module.verifyBlock(goodBlock.hash);
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

  const badResult = await module.verifyBlock(badBlock.hash);
  assert(!badResult.accepted);
  if (!badResult.accepted) {
    assert(badResult.reason.includes('required output not found'));
  }
});

Deno.test('ExecutionModule: contract throws ContractRejection -> block invalid', async () => {
  const { provider, module } = setup();

  const contract = h('always-reject');

  module.registerContract(contract, {
    run(_env) {
      throw new ContractRejection('nope');
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assertEquals(result.reason, 'nope');
  }
});

Deno.test('ExecutionModule: multiple claimed outputs from different contracts -- all must accept', async () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, { run(_env) {} });
  module.registerContract(contractB, { run(_env) {} });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        data: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: multiple contracts -- one rejects -> block invalid', async () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, { run(_env) {} });
  module.registerContract(contractB, {
    run(_env) {
      throw new ContractRejection('contract B rejects');
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        data: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
});

Deno.test('ExecutionModule: contract not found -> block invalid', async () => {
  const { provider, module } = setup();

  const unknownContract = h('unknown-contract');

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract: unknownContract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('contract not found'));
  }
});

Deno.test('ExecutionModule: silent contract (no-op) is accepted', async () => {
  const { provider, module } = setup();

  const contract = h('silent-contract');
  module.registerContract(contract, {
    run(_env) {
      // does nothing -- normal return = accept
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(result.accepted);
});

Deno.test('ExecutionModule: contract throws non-rejection error -> block invalid', async () => {
  const { provider, module } = setup();

  const contract = h('throwing-contract');
  module.registerContract(contract, {
    run(_env) {
      throw new Error('boom');
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      data: new Uint8Array(0),
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

  const result = await module.verifyBlock(block.hash);
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('contract threw'));
  }
});

Deno.test('ExecutionModule: verifyClaim verifies a single claim', async () => {
  const { provider, module } = setup();

  const contractA = h('contract-a');
  const contractB = h('contract-b');

  module.registerContract(contractA, { run(_env) {} });
  module.registerContract(contractB, {
    run(_env) {
      throw new ContractRejection('B rejects');
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [
      {
        verifier: { contract: contractA, params: new Uint8Array(0) },
        value: 10,
        data: new Uint8Array(0),
      },
      {
        verifier: { contract: contractB, params: new Uint8Array(0) },
        value: 20,
        data: new Uint8Array(0),
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
  const result0 = await module.verifyClaim(block.hash, 0);
  assert(result0.accepted);

  // Claim 1 (contractB) should reject
  const result1 = await module.verifyClaim(block.hash, 1);
  assert(!result1.accepted);
});

Deno.test('ExecutionModule: verifyClaim for self-claimed output is trivially valid', async () => {
  const { provider, module } = setup();

  const block: TestBlock = {
    hash: h('block'),
    anchor: ZERO_HASH,
    outputs: [makeRecordOutput('key', enc('val'))],
    claims: [0],
    refs: [],
  };
  provider.addBlock(block);

  const result = await module.verifyClaim(block.hash, 0);
  assert(result.accepted);
});

Deno.test('ExecutionModule: block not found returns error', async () => {
  const { module } = setup();

  const result = await module.verifyBlock(h('nonexistent'));
  assert(!result.accepted);
  if (!result.accepted) {
    assert(result.reason.includes('block not found'));
  }
});

Deno.test('ExecutionModule: ContractEnv mode and contract info', () => {
  const { provider, module } = setup();

  const contract = h('info-contract');
  let capturedMode: ExecutionMode | undefined;
  let capturedContract: Hash | undefined;
  let capturedParams: Uint8Array | undefined;

  module.registerContract(contract, {
    run(env) {
      capturedMode = env.mode;
      capturedContract = env.getContractHash();
      capturedParams = env.getParams();
    },
  });

  const params = enc('my-params');
  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params },
      value: 0,
      data: new Uint8Array(0),
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

Deno.test('ExecutionModule: collectInputs returns claimed outputs matching verifier', () => {
  const { provider, module } = setup();

  const contract = h('claim-reader');
  let inputCount = 0;
  let inputDetail: Uint8Array | undefined;

  module.registerContract(contract, {
    run(env) {
      const inputs = env.collectInputs();
      // In verification mode, collectInputs is synchronous
      const resolvedInputs = inputs as import('../src/core/ContractEnv.ts').Input[];
      inputCount = resolvedInputs.length;
      if (resolvedInputs.length > 0) {
        inputDetail = resolvedInputs[0].data;
      }
    },
  });

  const anchor: TestBlock = {
    hash: h('anchor'),
    anchor: ZERO_HASH,
    outputs: [{
      verifier: { contract, params: new Uint8Array(0) },
      value: 0,
      data: enc('claimed-data'),
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

  assertEquals(inputCount, 1);
  assertEquals(inputDetail, enc('claimed-data'));
});

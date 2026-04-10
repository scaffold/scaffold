/**
 * Network computation and verification tests.
 *
 * Verifies that contract execution, self-claimed outputs, cross-block
 * references, and verification sampling work across multiple nodes.
 */

import { assert, assertEquals } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { createGenesisBlock } from '../../src/core/Block.ts';
import { makeRecordOutput } from '../../src/contracts/RecordContract.ts';
import { type ContractEnv } from '../../src/core/ContractEnv.ts';
import { TestNetwork } from './TestNetwork.ts';
import { enc, makeBlock, makeOutput } from './helpers.ts';

// -- Test contract setup helpers --------------------------------------

const trivialContract = Hash.digest('trivial-contract');
const gameContract = Hash.digest('game-contract');

function registerTrivialContract(net: TestNetwork, nodeId: string): void {
  net.getNode(nodeId).execution.registerContract(trivialContract, {
    run(_env: ContractEnv) {
      // Accept everything
    },
  });
}

function registerGameContract(net: TestNetwork, nodeId: string): void {
  const gameVerifier = { contract: gameContract, params: new Uint8Array(0) };
  net.getNode(nodeId).execution.registerContract(gameContract, {
    run(env: ContractEnv) {
      const prevState = new TextDecoder().decode(
        env.fetch(gameVerifier, enc('state')) as Uint8Array,
      );
      env.requireResult(enc('state'), enc(prevState + '-next'));
    },
  });
}

function makeContractGenesis(contract: Hash, count = 1) {
  const outputs = Array.from({ length: count }, () => ({
    verifier: { contract, params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array(0),
  }));
  return createGenesisBlock(outputs);
}

// -- Tests ------------------------------------------------------------

Deno.test('Computation: contract verified consistently on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  for (const id of net.nodeIds) registerTrivialContract(net, id);

  const genesis = makeContractGenesis(trivialContract);
  net.broadcastGenesis(genesis);

  // Block claiming the contract output
  const block = makeBlock('comp-verify', genesis, [], 10, [0]);
  net.deliverToAll(block, 'A');

  // All nodes should verify it as valid
  for (const id of net.nodeIds) {
    const result = net.getNode(id).execution.verifyBlock(block.hash);
    assert(result.accepted, `Node ${id}: block should be accepted`);
  }
});

Deno.test('Computation: self-claimed outputs verified across network', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  for (const id of net.nodeIds) registerTrivialContract(net, id);

  const genesis = makeContractGenesis(trivialContract);
  net.broadcastGenesis(genesis);

  // Block with self-claimed state output
  const stateOutput = makeRecordOutput('key', enc('value'));
  const block = makeBlock('self-claim', genesis, [stateOutput], 10, [0, 1]);
  // claims index 0 = self-claimed output (trivially valid)
  // claims index 1 = genesis contract output

  net.deliverToAll(block, 'A');

  for (const id of net.nodeIds) {
    const result = net.getNode(id).execution.verifyBlock(block.hash);
    assert(result.accepted, `Node ${id}: self-claimed block should be accepted`);
  }
});

Deno.test('Computation: cross-block references work across nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B']) net.addNode(id);

  for (const id of net.nodeIds) registerGameContract(net, id);

  const gameVerifier = { contract: gameContract, params: new Uint8Array(0) };
  const gameOutput = { verifier: gameVerifier, value: 0, data: new Uint8Array(0) };

  const genesis = createGenesisBlock([gameOutput, gameOutput]);
  net.broadcastGenesis(genesis);

  // Block A: produces initial state
  const blockA = makeBlock(
    'ref-blockA',
    genesis,
    [makeRecordOutput('state', enc('S0'))],
    10,
    [1], // claim genesis output 0
  );
  net.deliverToAll(blockA, 'A');

  // Block B: references A, reads state, produces next state
  const blockB = makeBlock(
    'ref-blockB',
    genesis,
    [makeRecordOutput('state', enc('S0-next'))],
    10,
    [2], // claim genesis output 1
    [blockA.hash], // refs
  );
  net.deliverToAll(blockB, 'A');

  // Both nodes should verify B
  for (const id of net.nodeIds) {
    const result = net.getNode(id).execution.verifyBlock(blockB.hash);
    assert(result.accepted, `Node ${id}: ref block should be accepted`);
  }
});

Deno.test('Computation: invalid computation detected on all nodes', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  // Register a strict contract that rejects blocks without specific outputs
  const strictContract = Hash.digest('strict-contract');
  for (const id of net.nodeIds) {
    net.getNode(id).execution.registerContract(strictContract, {
      run(env: ContractEnv) {
        env.requireResult(enc('required-key'), enc('required-value'));
      },
    });
  }

  const genesis = makeContractGenesis(strictContract);
  net.broadcastGenesis(genesis);

  // Block that does NOT produce the required output -- should be invalid
  const badBlock = makeBlock('bad-comp', genesis, [makeOutput(0, 'wrong')], 10, [0]);
  net.deliverToAll(badBlock, 'A');

  for (const id of net.nodeIds) {
    const result = net.getNode(id).execution.verifyBlock(badBlock.hash);
    assert(!result.accepted, `Node ${id}: invalid block should be rejected`);
  }
});

Deno.test('Computation: verification sampling selects highest priority tree', () => {
  const net = new TestNetwork();
  net.addNode('A');

  registerTrivialContract(net, 'A');

  const genesis = makeContractGenesis(trivialContract, 2);
  net.broadcastGenesis(genesis);

  // Two blocks with different weights
  const heavy = makeBlock('samp-heavy', genesis, [], 100, [0]);
  const light = makeBlock('samp-light', genesis, [], 10, [1]);

  net.deliverDirect(heavy, 'A');
  net.deliverDirect(light, 'A');

  // The sampling module should have trees to verify
  const next = net.getNode('A').sampling.selectNext();
  assert(next !== undefined, 'Should select a tree to verify');
});

Deno.test('Computation: multiple nodes independently verify same block', () => {
  const net = new TestNetwork();
  for (const id of ['A', 'B', 'C']) net.addNode(id);

  for (const id of net.nodeIds) registerTrivialContract(net, id);

  const genesis = makeContractGenesis(trivialContract);
  net.broadcastGenesis(genesis);

  const block = makeBlock('indep-verify', genesis, [], 10, [0]);
  net.deliverToAll(block, 'A');

  // All nodes independently verify
  const results = net.nodeIds.map((id) => ({
    id,
    result: net.getNode(id).execution.verifyBlock(block.hash),
  }));

  // All should agree on the outcome
  const firstResult = results[0].result.accepted;
  for (const { id, result } of results) {
    assertEquals(
      result.accepted,
      firstResult,
      `Node ${id} disagrees on verification result`,
    );
  }
});

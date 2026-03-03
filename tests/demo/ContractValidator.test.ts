import { assert, assertFalse } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { Block, BlockStore, createBlock, createGenesisBlock } from '../../src/Block.ts';
import { BitVector } from '../../src/BitVector.ts';
import { Output, BlockSpec } from '../../src/BlockCreationModule.ts';
import { BlockCreationService } from '../../src/BlockCreationService.ts';
import { ProtocolContext } from '../../src/ProtocolContext.ts';
import { ConflictService } from '../../src/ConflictService.ts';
import { ConsensusService } from '../../src/ConsensusService.ts';
import { Coordinator } from '../../src/Coordinator.ts';

import { deriveIdentity } from '../../src/demo/Identity.ts';
import { makeStatusOutput } from '../../src/demo/StatusContract.ts';
import { signBlock, SignedBlock } from '../../src/demo/SignedBlock.ts';
import { validateSignedBlock } from '../../src/demo/ContractValidator.ts';
import { createDemoGenesis } from '../../src/demo/DemoGenesis.ts';

/** Set up a minimal protocol context with a block store. */
function setupStore(): { store: BlockStore; ctx: ProtocolContext; coordinator: Coordinator; blockCreation: BlockCreationService } {
  const ctx = new ProtocolContext();
  const store = ctx.get(BlockStore);
  const coordinator = ctx.get(Coordinator);
  const blockCreation = ctx.get(BlockCreationService);
  return { store, ctx, coordinator, blockCreation };
}

Deno.test('ContractValidator: genesis is always valid', () => {
  const { store } = setupStore();
  const genesis = createDemoGenesis();
  store.put(genesis);

  const eagle = deriveIdentity('eagle');
  const sb = signBlock(genesis, eagle.privateKey);

  const result = validateSignedBlock(sb, store);
  assert(result.ok);
});

Deno.test('ContractValidator: correct signer passes', () => {
  const { store, coordinator, blockCreation } = setupStore();

  const genesis = createDemoGenesis();
  coordinator.blockReceived(genesis, null);

  const eagle = deriveIdentity('eagle');

  // Build a block that claims eagle's status output and produces a new one
  // Eagle's output is at index 4 in the genesis (ANIMALS order: antelope=0, badger=1, crane=2, dolphin=3, eagle=4)
  const spec: BlockSpec = {
    anchor: genesis.hash,
    outputs: [makeStatusOutput(eagle.publicKey, 'Hello')],
    claims: [{ index: 1 + 4, value: 1 }], // ownOutputCount(1) + genesis index(4) = 5
    declaredWeight: 1,
    aggregates: [],
  };

  const buildResult = blockCreation.buildBlock(spec);
  assert(buildResult.ok);
  if (!buildResult.ok) return;

  const block = createBlock(buildResult.blueprint, genesis);
  const sb = signBlock(block, eagle.privateKey);

  const result = validateSignedBlock(sb, store);
  assert(result.ok, `Expected valid but got: ${!result.ok ? result.reason : ''}`);
});

Deno.test('ContractValidator: wrong signer (eagle signs badger output) fails', () => {
  const { store, coordinator, blockCreation } = setupStore();

  const genesis = createDemoGenesis();
  coordinator.blockReceived(genesis, null);

  const eagle = deriveIdentity('eagle');
  const badger = deriveIdentity('badger');

  // Build a block that claims badger's status output (index 1) but sign with eagle's key
  const spec: BlockSpec = {
    anchor: genesis.hash,
    outputs: [makeStatusOutput(badger.publicKey, 'Impersonation')],
    claims: [{ index: 1 + 1, value: 1 }], // ownOutputCount(1) + genesis index(1) = 2
    declaredWeight: 1,
    aggregates: [],
  };

  const buildResult = blockCreation.buildBlock(spec);
  assert(buildResult.ok);
  if (!buildResult.ok) return;

  const block = createBlock(buildResult.blueprint, genesis);
  const sb = signBlock(block, eagle.privateKey); // eagle signs badger's output!

  const result = validateSignedBlock(sb, store);
  assertFalse(result.ok);
  if (!result.ok) {
    assert(result.reason.includes('signature'));
  }
});

Deno.test('ContractValidator: block without status outputs passes without signature', () => {
  const { store, coordinator, blockCreation } = setupStore();

  const genesis = createDemoGenesis();
  coordinator.blockReceived(genesis, null);

  // A block that produces a non-status output and claims nothing
  const nonStatusOutput: Output = {
    contract: Hash.digest('other-contract'),
    value: 0,
    data: new Uint8Array([]),
  };

  const spec: BlockSpec = {
    anchor: genesis.hash,
    outputs: [nonStatusOutput],
    claims: [],
    declaredWeight: 1,
    aggregates: [],
  };

  const buildResult = blockCreation.buildBlock(spec);
  assert(buildResult.ok);
  if (!buildResult.ok) return;

  const block = createBlock(buildResult.blueprint, genesis);
  // Sign with any key — doesn't matter since no status outputs
  const eagle = deriveIdentity('eagle');
  const sb = signBlock(block, eagle.privateKey);

  const result = validateSignedBlock(sb, store);
  assert(result.ok);
});

import { assert, assertThrows } from '@std/assert';
import { Hash } from '../../src/util/Hash.ts';
import { BlockStore } from '../../src/core/Block.ts';
import { BlockSpec, Output } from '../../src/core/BlockCreationModule.ts';
import { BlockCreationService } from '../../src/core/BlockCreationService.ts';
import { ProtocolContext } from '../../src/core/ProtocolContext.ts';
import { Coordinator } from '../../src/core/Coordinator.ts';

import { deriveIdentity } from '../../src/demo/Identity.ts';
import { makeStatusOutput } from '../../src/demo/StatusContract.ts';
import { composeBlockPacket } from '../../src/core/Packet.ts';
import { validateBlockPacket } from '../../src/demo/ContractValidator.ts';
import { createDemoGenesis } from '../../src/demo/DemoGenesis.ts';

/** Set up a minimal protocol context with a block store. */
function setupStore(): {
  store: BlockStore;
  ctx: ProtocolContext;
  coordinator: Coordinator;
  blockCreation: BlockCreationService;
} {
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
  // Genesis is unsigned, but for this test we compose a signed packet just to have a packet
  // Genesis blocks always pass validation regardless
  const { packet } = composeBlockPacket(
    {
      anchor: genesis.anchor,
      aggregates: genesis.aggregates,
      claims: genesis.claims,
      outputs: genesis.outputs,
      declaredWeight: genesis.declaredWeight,
      refs: genesis.refs,
    },
    eagle.privateKey,
  );

  validateBlockPacket(packet, store); // should not throw
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
    refs: [],
  };

  const blueprint = blockCreation.buildBlock(spec);
  const { packet } = composeBlockPacket(blueprint, eagle.privateKey);

  validateBlockPacket(packet, store); // should not throw
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
    refs: [],
  };

  const blueprint = blockCreation.buildBlock(spec);
  const { packet } = composeBlockPacket(blueprint, eagle.privateKey); // eagle signs badger's output!

  assertThrows(
    () => validateBlockPacket(packet, store),
    Error,
    'signature',
  );
});

Deno.test('ContractValidator: block without status outputs passes without signature', () => {
  const { store, coordinator, blockCreation } = setupStore();

  const genesis = createDemoGenesis();
  coordinator.blockReceived(genesis, null);

  // A block that produces a non-status output and claims nothing
  const nonStatusOutput: Output = {
    verifier: { contract: Hash.digest('other-contract'), params: new Uint8Array(0) },
    value: 0,
    data: new Uint8Array([]),
  };

  const spec: BlockSpec = {
    anchor: genesis.hash,
    outputs: [nonStatusOutput],
    claims: [],
    declaredWeight: 1,
    aggregates: [],
    refs: [],
  };

  const blueprint = blockCreation.buildBlock(spec);

  // Sign with any key — doesn't matter since no status outputs
  const eagle = deriveIdentity('eagle');
  const { packet } = composeBlockPacket(blueprint, eagle.privateKey);

  validateBlockPacket(packet, store); // should not throw
});

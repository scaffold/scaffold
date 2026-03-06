import { assert, assertEquals, assertThrows } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import { Block } from '../src/core/Block.ts';
import { BlockSpec, Output } from '../src/core/BlockCreationModule.ts';
import { BlockProcessor, PutManager, PutRequest } from '../src/node/PutManager.ts';

// -- Test helpers ------------------------------------------------

function makeOutput(value: number, contractName?: string): Output {
  return {
    contract: contractName ? Hash.digest(contractName) : Hash.digest('default-contract'),
    value,
    data: new Uint8Array(),
  };
}

function makeBlock(overrides?: Partial<Block>): Block {
  return {
    hash: Hash.random(),
    anchor: ZERO_HASH,
    aggregates: [],
    claims: [],
    outputs: [],
    declaredWeight: 1,
    ...overrides,
  };
}

class MockProcessor implements BlockProcessor {
  lastSpec: BlockSpec | null = null;
  processedBlocks: Block[] = [];
  blockToReturn: Block | null = makeBlock();

  buildBlock(spec: BlockSpec): Block | null {
    this.lastSpec = spec;
    return this.blockToReturn;
  }

  processBlock(block: Block): void {
    this.processedBlocks.push(block);
  }
}

// -- Tests -------------------------------------------------------

Deno.test('PutManager: basic put with outputs creates a block', () => {
  const processor = new MockProcessor();
  const expectedBlock = makeBlock({ outputs: [makeOutput(100)] });
  processor.blockToReturn = expectedBlock;
  const manager = new PutManager(processor);

  const result = manager.put({
    outputs: [makeOutput(100)],
  });

  assert(processor.lastSpec !== null);
  assertEquals(processor.lastSpec!.outputs.length, 1);
  assertEquals(processor.lastSpec!.outputs[0].value, 100);
  assertEquals(result.block, expectedBlock);
  assertEquals(result.hash, expectedBlock.hash);
  assertEquals(processor.processedBlocks.length, 1);
  assertEquals(processor.processedBlocks[0], expectedBlock);
});

Deno.test('PutManager: put with satisfies creates claims', () => {
  const processor = new MockProcessor();
  const manager = new PutManager(processor);
  const incentiveHash = Hash.random();

  manager.put({
    outputs: [makeOutput(50)],
    satisfies: incentiveHash,
  });

  assert(processor.lastSpec !== null);
  assert(processor.lastSpec!.claims.length > 0, 'claims should be non-empty when satisfies is set');
});

Deno.test('PutManager: put with declared weight', () => {
  const processor = new MockProcessor();
  const manager = new PutManager(processor);

  manager.put({
    outputs: [makeOutput(10)],
    declaredWeight: 42,
  });

  assert(processor.lastSpec !== null);
  assertEquals(processor.lastSpec!.declaredWeight, 42);
});

Deno.test('PutManager: put throws when buildBlock returns null', () => {
  const processor = new MockProcessor();
  processor.blockToReturn = null;
  const manager = new PutManager(processor);

  assertThrows(
    () => {
      manager.put({ outputs: [makeOutput(10)] });
    },
    Error,
    'Failed to build block',
  );
});

Deno.test('PutManager: default declared weight is 1', () => {
  const processor = new MockProcessor();
  const manager = new PutManager(processor);

  manager.put({
    outputs: [makeOutput(10)],
  });

  assert(processor.lastSpec !== null);
  assertEquals(processor.lastSpec!.declaredWeight, 1);
});

Deno.test('PutManager: put with no satisfies creates no claims', () => {
  const processor = new MockProcessor();
  const manager = new PutManager(processor);

  manager.put({
    outputs: [makeOutput(10)],
  });

  assert(processor.lastSpec !== null);
  assertEquals(processor.lastSpec!.claims.length, 0);
});

Deno.test('PutManager: aggregates are always empty', () => {
  const processor = new MockProcessor();
  const manager = new PutManager(processor);

  manager.put({
    outputs: [makeOutput(10)],
    satisfies: Hash.random(),
    declaredWeight: 5,
  });

  assert(processor.lastSpec !== null);
  assertEquals(processor.lastSpec!.aggregates.length, 0);
});

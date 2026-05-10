import { assert, assertEquals } from '@std/assert';
import { Hash, ZERO_HASH } from '../src/util/Hash.ts';
import type { Output } from '../src/core/BlockCreationModule.ts';
import { createGenesisBlock } from '../src/core/Block.ts';
import { deserialize, serialize } from '../src/core/BlockSerializer.ts';

const h = (s: string): Hash => Hash.digest(s);

function makeOutput(data?: Uint8Array): Output {
  return {
    verifier: { contract: h('c'), params: new Uint8Array(0) },
    value: 1,
    data,
  };
}

// -- Hash distinctness ---------------------------------------------

Deno.test('block hash: data-less and empty-bytes data produce distinct hashes', () => {
  const dataLessBlock = createGenesisBlock([makeOutput()]);
  const emptyBlock = createGenesisBlock([makeOutput(new Uint8Array(0))]);
  assert(
    !Hash.equals(dataLessBlock.hash, emptyBlock.hash),
    'data-less and empty-bytes outputs must hash differently',
  );
});

Deno.test('block hash: two blocks with identical data-less outputs match', () => {
  const a = createGenesisBlock([makeOutput()]);
  const b = createGenesisBlock([makeOutput()]);
  assert(Hash.equals(a.hash, b.hash));
});

// -- Serializer round-trip -----------------------------------------

Deno.test('serializer: data-less, empty-bytes, and non-empty data survive round-trip distinctly', () => {
  const outputs: Output[] = [
    makeOutput(),
    makeOutput(new Uint8Array(0)),
    makeOutput(new TextEncoder().encode('payload')),
  ];
  const json = serialize(outputs);
  const decoded = deserialize<Output[]>(json);

  assertEquals(decoded.length, 3);
  assertEquals(decoded[0].data, undefined);
  assert(decoded[1].data instanceof Uint8Array);
  assertEquals((decoded[1].data as Uint8Array).length, 0);
  assert(decoded[2].data instanceof Uint8Array);
  assertEquals(
    new TextDecoder().decode(decoded[2].data as Uint8Array),
    'payload',
  );
});

Deno.test('serializer: data-less round-trips through a full genesis block', () => {
  const outputs: Output[] = [makeOutput(), makeOutput(new Uint8Array(0))];
  const block = createGenesisBlock(outputs);
  const json = serialize(block);
  const decoded = deserialize<typeof block>(json);
  assertEquals(decoded.outputs.length, 2);
  assertEquals(decoded.outputs[0].data, undefined);
  assert(decoded.outputs[1].data instanceof Uint8Array);
  // Anchor hash recovered via reviver
  assert(decoded.anchor instanceof Hash);
  assert(Hash.equals(decoded.anchor, ZERO_HASH));
});

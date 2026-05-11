import { assertEquals, assert } from '@std/assert';

const TOOL_PATH = new URL('../scripts/wasm-determinism/bin/wasm-determinism.wasm', import.meta.url);
const FIXTURES_DIR = new URL('./fixtures/wasm-determinism/', import.meta.url);

interface RunResult {
  result: number;
  output: Uint8Array | null;
  logs: string[];
}

async function loadFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(`${name}.wasm`, FIXTURES_DIR));
}

async function loadTool(): Promise<Uint8Array> {
  return await Deno.readFile(TOOL_PATH);
}

async function runTool(input: Uint8Array): Promise<RunResult> {
  const toolBytes = await loadTool();
  const memory = new WebAssembly.Memory({ initial: 512, maximum: 4096 });
  const logs: string[] = [];
  const env = {
    memory,
    log: (ptr: number, len: number) => {
      const bytes = new Uint8Array(memory.buffer, ptr, len);
      logs.push(new TextDecoder().decode(bytes));
    },
  };
  const { instance } = (await WebAssembly.instantiate(toolBytes as BufferSource, { env })) as { instance: WebAssembly.Instance };
  const inputOffset = (instance.exports.input_buffer as () => number)();
  const outputOffset = (instance.exports.output_buffer as () => number)();
  const transform = instance.exports.transform as (n: number) => number;
  new Uint8Array(memory.buffer, inputOffset, input.length).set(input);
  const result = transform(input.length);
  let output: Uint8Array | null = null;
  if (result > 0) {
    output = new Uint8Array(memory.buffer, outputOffset, result).slice();
  }
  return { result, output, logs };
}

Deno.test('clean fixture (already valid + version-marked) returns 0', async () => {
  const input = await loadFixture('clean');
  const r = await runTool(input);
  assertEquals(r.result, 0, `expected unchanged, got result=${r.result}, logs=${JSON.stringify(r.logs)}`);
  assertEquals(r.output, null);
});

Deno.test('memory_section fixture is rewritten with memory import', async () => {
  const input = await loadFixture('memory_section');
  const r = await runTool(input);
  assert(r.result > 0, `expected transformed, got result=${r.result}`);
  assert(r.output !== null);
  // Output should instantiate with env.memory import.
  const memory = new WebAssembly.Memory({ initial: 1 });
  const { instance } = (await WebAssembly.instantiate(r.output! as BufferSource, { env: { memory } })) as { instance: WebAssembly.Instance };
  const main = instance.exports.main as (n: number) => number;
  assertEquals(main(41), 42);
});

Deno.test('memory_section idempotence: re-transform returns 0', async () => {
  const input = await loadFixture('memory_section');
  const first = await runTool(input);
  assert(first.result > 0);
  const second = await runTool(first.output!);
  assertEquals(second.result, 0, `re-transform should be unchanged, got ${second.result}`);
});

for (const name of [
  'banned_reinterpret',
  'banned_shared_memory',
  'banned_atomic',
  'banned_exception',
  'banned_relaxed_simd',
]) {
  Deno.test(`${name} returns -1`, async () => {
    const input = await loadFixture(name);
    const r = await runTool(input);
    assertEquals(r.result, -1, `expected -1, got result=${r.result}`);
  });
}

Deno.test('memory_imported fixture gets version-stamped on first pass, idempotent after', async () => {
  const input = await loadFixture('memory_imported');
  const first = await runTool(input);
  assert(first.result > 0, `expected transformed, got result=${first.result}`);
  const second = await runTool(first.output!);
  assertEquals(second.result, 0, `re-transform should be unchanged, got ${second.result}`);
});

Deno.test('memory_grow gets abstain guard inserted', async () => {
  const input = await loadFixture('memory_grow');
  const r = await runTool(input);
  assert(r.result > 0, `expected transformed, got result=${r.result}`);
  // Output should instantiate (we provide env.memory + env.abstain).
  const memory = new WebAssembly.Memory({ initial: 1 });
  let abstainCalled = false;
  const { instance } = (await WebAssembly.instantiate(r.output! as BufferSource, {
    env: { memory, abstain: () => { abstainCalled = true; } },
  })) as { instance: WebAssembly.Instance };
  const doGrow = instance.exports.do_grow as (n: number) => number;
  // Growing by 1 page succeeds (returns previous size = 1). Abstain not called.
  assertEquals(doGrow(1), 1);
  assertEquals(abstainCalled, false);
  // Subsequent grow re-runs return prev page count; the guard only fires on -1.
});

Deno.test('memory_grow idempotence: re-transform returns 0', async () => {
  const input = await loadFixture('memory_grow');
  const first = await runTool(input);
  assert(first.result > 0);
  const second = await runTool(first.output!);
  assertEquals(second.result, 0, `re-transform should be unchanged, got ${second.result}`);
});

Deno.test('memory_grow_no_abstain returns -1', async () => {
  const input = await loadFixture('memory_grow_no_abstain');
  const r = await runTool(input);
  assertEquals(r.result, -1, `expected -1, got result=${r.result}`);
});

Deno.test('transformer is deterministic: same input produces same output', async () => {
  const input = await loadFixture('memory_section');
  const a = await runTool(input);
  const b = await runTool(input);
  assertEquals(a.result, b.result);
  assert(a.output !== null && b.output !== null);
  assertEquals(a.output!.length, b.output!.length);
  for (let i = 0; i < a.output!.length; i++) {
    assertEquals(a.output![i], b.output![i], `byte ${i} differs`);
  }
});

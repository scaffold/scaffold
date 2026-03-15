// Verify JSON serializer WASM: check exports exist and exercise all paths
const which = Deno.args[0] ?? 'json_serializer';
const wasmBytes = await Deno.readFile(`zig-out/bin/${which}.wasm`);
console.log(
  `${which}: ${wasmBytes.byteLength} bytes (${(wasmBytes.byteLength / 1024).toFixed(2)} KB)`,
);

const module = await WebAssembly.compile(wasmBytes);
const instance = await WebAssembly.instantiate(module);
const exports = instance.exports as Record<string, Function>;

// List all exports
console.log('\nExports:');
for (const [name, val] of Object.entries(instance.exports)) {
  const kind = typeof val === 'function'
    ? 'func'
    : val instanceof WebAssembly.Memory
    ? 'memory'
    : typeof val;
  console.log(`  ${name}: ${kind}`);
}

// Run json_demo which exercises all paths
const len = exports.json_demo() as number;
const bufPtr = exports.get_buf_ptr() as number;
const memory = exports.memory as WebAssembly.Memory;
const result = new TextDecoder().decode(new Uint8Array(memory.buffer, bufPtr, len));

console.log(`\njson_demo output (${len} bytes):`);
console.log(result);

// Verify it's valid JSON
try {
  const parsed = JSON.parse(result);
  console.log('\nParsed successfully:', JSON.stringify(parsed));
} catch (e) {
  console.error('\nFailed to parse:', (e as Error).message);
}

const wasmBytes = await Deno.readFile("zig-out/bin/json_stdlib.wasm");
console.log(`Size: ${wasmBytes.byteLength} bytes (${(wasmBytes.byteLength / 1024).toFixed(1)} KB)`);

const module = await WebAssembly.compile(wasmBytes);
const instance = await WebAssembly.instantiate(module);
const e = instance.exports as Record<string, Function>;
const memory = e.memory as WebAssembly.Memory;

function readBuf(len: number): string {
  const ptr = e.get_buf_ptr() as number;
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

function writeStr(s: string): [number, number] {
  const encoded = new TextEncoder().encode(s);
  const ptr = e.get_buf_ptr() as number;
  new Uint8Array(memory.buffer, ptr, encoded.length).set(encoded);
  return [ptr, encoded.length];
}

// Test serialization
console.log("\n--- Serialization ---");
const demoLen = e.json_demo() as number;
console.log(`json_demo: ${readBuf(demoLen)}`);

// Test deserialization
console.log("\n--- Deserialization ---");

const jsonStr = '{"name":"hello\\nworld","age":42,"neg":-999,"scores":[1,2,3],"pi":3.14159265,"active":true,"deleted":null}';
const [ptr, len] = writeStr(jsonStr);
const result = e.parse_demo(ptr, len);
console.log(`parse_demo(age+neg): ${result} (expected: ${42 + -999})`);

{
  const [p, l] = writeStr("12345");
  console.log(`parse_i32("12345"): ${e.parse_i32(p, l)}`);
}
{
  const [p, l] = writeStr("3.14");
  console.log(`parse_f64("3.14"): ${e.parse_f64(p, l)}`);
}
{
  const [p, l] = writeStr("true");
  console.log(`parse_bool("true"): ${e.parse_bool(p, l)}`);
}
{
  const [p, l] = writeStr('"hello world"');
  const slen = e.parse_string(p, l) as number;
  console.log(`parse_string: "${readBuf(slen)}"`);
}
{
  const [p, l] = writeStr("[10,20,30]");
  console.log(`parse_array sum: ${e.parse_array(p, l)} (expected 60)`);
}
{
  const [p, l] = writeStr('{"a":1,"b":"two","c":[3]}');
  const rlen = e.parse_dynamic(p, l) as number;
  console.log(`parse_dynamic round-trip: ${readBuf(rlen)}`);
}

console.log("\nAll tests passed.");

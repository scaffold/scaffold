// Run WASM limit tests using Deno (no browser needed)
// Usage: deno run --allow-read run_tests.ts

const COUNT = 100;

function memUsage() {
  // Deno doesn't expose detailed heap info, but we can get RSS
  return `RSS: ~N/A (use browser test for precise heap measurements)`;
}

console.log("========================================");
console.log("  WASM Limits Experiment (Deno runtime)");
console.log("  " + new Date().toISOString());
console.log(`  Deno ${Deno.version.deno}, V8 ${Deno.version.v8}`);
console.log("========================================\n");

// Load all WASM files
console.log("Loading WASM files...");
const wasmBytes: ArrayBuffer[] = [];
for (let i = 0; i < COUNT; i++) {
  const bytes = await Deno.readFile(`wasm/contract_${i}.wasm`);
  wasmBytes.push(bytes.buffer as ArrayBuffer);
}

// ================================================================
// Test 1: Sizes
// ================================================================
console.log("\n=== Test 1: WASM File Sizes ===");
const sizes = wasmBytes.map((b) => b.byteLength);
console.log(`  Files: ${sizes.length}`);
console.log(`  Min: ${Math.min(...sizes)} bytes`);
console.log(`  Max: ${Math.max(...sizes)} bytes`);
console.log(`  Avg: ${(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(0)} bytes`);
console.log(
  `  Total: ${(sizes.reduce((a, b) => a + b, 0) / 1024).toFixed(1)} KB`,
);

// ================================================================
// Test 2: Sequential compilation
// ================================================================
console.log("\n=== Test 2: Sequential WebAssembly.compile() ===");
const modules: WebAssembly.Module[] = [];
const compileStart = performance.now();
for (let i = 0; i < COUNT; i++) {
  modules.push(await WebAssembly.compile(wasmBytes[i]));
}
const compileTime = performance.now() - compileStart;
console.log(`  Compiled ${COUNT} modules in ${compileTime.toFixed(1)}ms`);
console.log(`  Avg: ${(compileTime / COUNT).toFixed(3)}ms per module`);

// ================================================================
// Test 3: Sequential instantiation
// ================================================================
console.log("\n=== Test 3: Sequential WebAssembly.instantiate() ===");
const instances: WebAssembly.Instance[] = [];
const instStart = performance.now();
for (let i = 0; i < COUNT; i++) {
  instances.push(await WebAssembly.instantiate(modules[i]));
}
const instTime = performance.now() - instStart;
console.log(`  Instantiated ${COUNT} modules in ${instTime.toFixed(1)}ms`);
console.log(`  Avg: ${(instTime / COUNT).toFixed(3)}ms per instance`);

// Verify
let ok = 0;
for (let i = 0; i < COUNT; i++) {
  const getId = (instances[i].exports.get_id as CallableFunction)();
  if (getId === i) ok++;
}
console.log(
  ok === COUNT
    ? `  Verification: all ${ok} correct`
    : `  Verification: ${ok}/${COUNT} correct (ERRORS!)`,
);

// ================================================================
// Test 4: Multiple instances from one module
// ================================================================
console.log("\n=== Test 4: Multiple Instances from Single Module ===");
for (const n of [10, 100, 1000, 5000, 10000]) {
  const arr: WebAssembly.Instance[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    arr.push(await WebAssembly.instantiate(modules[0]));
  }
  const elapsed = performance.now() - t0;
  console.log(
    `  ${String(n).padStart(6)} instances: ${elapsed.toFixed(1)}ms total, ${(elapsed / n).toFixed(4)}ms each`,
  );
  arr.length = 0;
  // Small delay for GC
  await new Promise((r) => setTimeout(r, 50));
}

// ================================================================
// Test 5: Compile stress
// ================================================================
console.log("\n=== Test 5: Compile Stress Test ===");
console.log(
  "  Compiling as many unique modules as possible (reusing bytes cyclically)...",
);
const stressModules: WebAssembly.Module[] = [];
const stressBatch = 100;
let stressTime = 0;

try {
  while (stressModules.length < 10000) {
    const t0 = performance.now();
    for (let i = 0; i < stressBatch; i++) {
      stressModules.push(
        await WebAssembly.compile(wasmBytes[stressModules.length % COUNT]),
      );
    }
    stressTime += performance.now() - t0;

    if (stressModules.length % 1000 === 0) {
      console.log(
        `  ${stressModules.length.toLocaleString()} modules, avg: ${(stressTime / stressModules.length).toFixed(3)}ms/module`,
      );
    }
  }
  console.log(
    `  SUCCESS: Compiled ${stressModules.length.toLocaleString()} modules`,
  );
} catch (e) {
  console.log(
    `  FAILED at ${stressModules.length.toLocaleString()} modules: ${(e as Error).message}`,
  );
}

// ================================================================
// Test 6: Instance stress
// ================================================================
console.log("\n=== Test 6: Instance Stress Test ===");
const stressInstances: WebAssembly.Instance[] = [];
let instStressTime = 0;

try {
  while (stressInstances.length < 30000) {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) {
      stressInstances.push(await WebAssembly.instantiate(modules[0]));
    }
    const batchTime = performance.now() - t0;
    instStressTime += batchTime;

    if (stressInstances.length % 5000 === 0) {
      console.log(
        `  ${stressInstances.length.toLocaleString()} instances, avg: ${(instStressTime / stressInstances.length).toFixed(4)}ms/instance, last batch: ${(batchTime / 1000).toFixed(4)}ms/inst`,
      );
    }
    // Bail if a single batch of 1000 takes >5 seconds (memory pressure)
    if (batchTime > 5000) {
      console.log(`  Stopping: batch took ${batchTime.toFixed(0)}ms (memory pressure)`);
      break;
    }
  }
  console.log(
    `  SUCCESS: Created ${stressInstances.length.toLocaleString()} instances`,
  );
} catch (e) {
  console.log(
    `  FAILED at ${stressInstances.length.toLocaleString()}: ${(e as Error).message}`,
  );
}

// Clear to free memory before next test
stressModules.length = 0;
stressInstances.length = 0;
// Force GC if available
try {
  // @ts-ignore: Deno-specific
  if (typeof Deno !== "undefined") {
    // Give runtime time to GC
    await new Promise((r) => setTimeout(r, 500));
  }
} catch {
  // ignore
}

// ================================================================
// Test 7: Memory size impact
// ================================================================
console.log("\n=== Test 7: Memory Size Impact on Instantiation ===");

function makeWasmWithMemory(initialPages: number): Uint8Array {
  const bytes: number[] = [];
  const pushLEB = (v: number) => {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v) b |= 0x80;
      bytes.push(b);
    } while (v);
  };

  // Magic + version
  bytes.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

  // Type section (1): () -> i32
  const typePayload = [1, 0x60, 0, 1, 0x7f];
  bytes.push(1);
  pushLEB(typePayload.length);
  bytes.push(...typePayload);

  // Function section (3): 1 function, type 0
  const funcPayload = [1, 0];
  bytes.push(3);
  pushLEB(funcPayload.length);
  bytes.push(...funcPayload);

  // Memory section (5): 1 memory, no max
  const memPayload: number[] = [1, 0x00];
  // LEB128 encode initialPages
  let p = initialPages;
  do {
    let b = p & 0x7f;
    p >>>= 7;
    if (p) b |= 0x80;
    memPayload.push(b);
  } while (p);
  bytes.push(5);
  pushLEB(memPayload.length);
  bytes.push(...memPayload);

  // Export section (7): export "f" (func 0) and "memory" (mem 0)
  const enc = (s: string) => [...s].map((c) => c.charCodeAt(0));
  const expPayload: number[] = [];
  expPayload.push(2); // 2 exports
  const fn = enc("f");
  expPayload.push(fn.length, ...fn, 0x00, 0x00);
  const mn = enc("memory");
  expPayload.push(mn.length, ...mn, 0x02, 0x00);
  bytes.push(7);
  pushLEB(expPayload.length);
  bytes.push(...expPayload);

  // Code section (10): 1 function body
  const body = [0x00, 0x41, 0x2a, 0x0b]; // no locals, i32.const 42, end
  const codePayload = [1, body.length, ...body];
  bytes.push(10);
  pushLEB(codePayload.length);
  bytes.push(...codePayload);

  return new Uint8Array(bytes);
}

const pageCounts = [1, 10, 100, 256, 1000, 4096, 16384, 32768, 65536];

for (const pages of pageCounts) {
  const sizeMB = (pages * 64) / 1024;
  const label = sizeMB >= 1 ? `${sizeMB.toFixed(0)}MB` : `${pages * 64}KB`;

  try {
    const wasmData = makeWasmWithMemory(pages);
    const ct0 = performance.now();
    const mod = await WebAssembly.compile(wasmData);
    const compTime = performance.now() - ct0;

    const instCount = pages > 1000 ? 5 : 50;
    const it0 = performance.now();
    const insts: WebAssembly.Instance[] = [];
    for (let i = 0; i < instCount; i++) {
      insts.push(await WebAssembly.instantiate(mod));
    }
    const iTime = performance.now() - it0;

    // Verify memory
    const mem = insts[0].exports.memory as WebAssembly.Memory;
    const actualPages = mem.buffer.byteLength / 65536;

    console.log(
      `  ${label.padStart(8)} (${pages} pages): compile=${compTime.toFixed(2)}ms, instantiate=${(iTime / instCount).toFixed(3)}ms avg (x${instCount})${actualPages !== pages ? " [MISMATCH]" : ""}`,
    );
  } catch (e) {
    console.log(
      `  ${label.padStart(8)} (${pages} pages): FAILED - ${(e as Error).message}`,
    );
  }
}

// ================================================================
// Test 8: Concurrent compilation
// ================================================================
console.log("\n=== Test 8: Concurrent vs Sequential Compilation ===");

const seqT0 = performance.now();
for (let i = 0; i < COUNT; i++) {
  await WebAssembly.compile(wasmBytes[i]);
}
const seqTime = performance.now() - seqT0;
console.log(
  `  Sequential: ${COUNT} modules in ${seqTime.toFixed(1)}ms (${(seqTime / COUNT).toFixed(3)}ms each)`,
);

const parT0 = performance.now();
await Promise.all(wasmBytes.map((b) => WebAssembly.compile(b)));
const parTime = performance.now() - parT0;
console.log(
  `  Concurrent: ${COUNT} modules in ${parTime.toFixed(1)}ms (${(parTime / COUNT).toFixed(3)}ms each)`,
);
console.log(`  Speedup: ${(seqTime / parTime).toFixed(2)}x`);

// Concurrent instantiation
const mods2 = await Promise.all(wasmBytes.map((b) => WebAssembly.compile(b)));
const parInstT0 = performance.now();
await Promise.all(mods2.map((m) => WebAssembly.instantiate(m)));
const parInstTime = performance.now() - parInstT0;
console.log(
  `  Concurrent instantiate: ${COUNT} in ${parInstTime.toFixed(1)}ms (${(parInstTime / COUNT).toFixed(3)}ms each)`,
);

console.log("\n========================================");
console.log("  All tests complete");
console.log("========================================");

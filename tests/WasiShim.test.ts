// End-to-end snapshot tests for the Zig WASI shim.
//
// Each test stacks the shim above a tiny WASI program WAT fixture. The
// program imports specific `wasi_snapshot_preview1.*` calls and exercises
// them; the snapshot captures the cross-layer hops + scaffold_env calls
// the shim makes back to base.
//
// Regenerate snapshots: deno test --allow-all tests/WasiShim.test.ts -- --update
//
// IMPORTANT: the shim WASM blob must be built first. Run:
//
//   cd src/contracts/wasi-shim && \
//     ZIG_GLOBAL_CACHE_DIR=/tmp/zig-cache zig build -Drelease
//
// then re-run tests. Until the blob is built, every test in this file
// fails with a clear message.

import { assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { assertContractTraceSnapshot } from './helpers/contractSnapshot.ts';
import { buildWasiContract } from '../src/contracts/wasi-shim/setup.ts';

function programBytes(memories: ReadonlyMap<string, WebAssembly.Memory>, off: number, len: number): Uint8Array {
  const m = memories.get('program');
  if (!m) throw new Error('program memory not found');
  return new Uint8Array(m.buffer, off, len).slice();
}

function readU32LE(bytes: Uint8Array): number {
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0);
}

function readU64LE(bytes: Uint8Array): bigint {
  const lo = BigInt(readU32LE(bytes.subarray(0, 4)));
  const hi = BigInt(readU32LE(bytes.subarray(4, 8)));
  return (hi << 32n) | lo;
}

const SHIM_PATH = new URL(
  '../src/contracts/wasi-shim/dist/wasi-shim.wasm',
  import.meta.url,
);

async function loadShim(): Promise<Uint8Array> {
  try {
    return await Deno.readFile(SHIM_PATH);
  } catch (err) {
    throw new Error(
      `WasiShim tests: shim WASM blob not found at ${SHIM_PATH}.\n` +
        `Build it first:\n` +
        `  cd src/contracts/wasi-shim && \\\n` +
        `    ZIG_GLOBAL_CACHE_DIR=$TMPDIR/zig-cache zig build -Drelease\n\n` +
        `Underlying error: ${(err as Error).message}`,
    );
  }
}

async function loadFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(`./fixtures/wasm/${name}.wasm`, import.meta.url));
}

// Default mock: timestamp + contract_hash, both consumed at run-init. Tests
// override or extend per-case.
function baseMock() {
  return {
    mode: ExecutionMode.Verification,
    timestamp: 1700000000000,
    contractHash: Hash.fromBytes(new Uint8Array(32)),
  };
}

// -- Fixture: clock_time_get(REALTIME) ------------------------------

Deno.test('WasiShim: clock_time_get(REALTIME) writes block timestamp × 1e6', async (t) => {
  const shimBytes = await loadShim();
  const progBytes = await loadFixture('wasi_clock_probe');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: progBytes });
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    sequence: [],
    afterRun: (memories) => {
      // Probe writes the time to program offset 100 as LE u64 nanoseconds.
      // REALTIME maps to block timestamp (ms) × 1_000_000.
      const time_ns = readU64LE(programBytes(memories, 100, 8));
      assertEquals(time_ns, 1700000000000n * 1000000n);
    },
  });
});

// -- Fixture: proc_exit(7) -----------------------------------------

Deno.test('WasiShim: proc_exit(7) surfaces as ContractRejection with the WASI prefix', async (t) => {
  const shimBytes = await loadShim();
  const programBytes = await loadFixture('wasi_proc_exit_7');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: programBytes });
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    sequence: [
      { type: 'reject', expect: { reason: 'WASI proc_exit: 7' } },
    ],
  });
});

// -- Fixture: args_sizes_get with empty argv -----------------------

Deno.test('WasiShim: args_sizes_get returns (0,0) under default empty argv', async (t) => {
  const shimBytes = await loadShim();
  const progBytes = await loadFixture('wasi_args_sizes');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: progBytes });
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    sequence: [],
    afterRun: (memories) => {
      // Probe stores argc at offset 100, argv_buf_size at offset 104.
      // Both should be 0 with default empty argv.
      assertEquals(readU32LE(programBytes(memories, 100, 4)), 0);
      assertEquals(readU32LE(programBytes(memories, 104, 4)), 0);
    },
  });
});

// -- Fixture: random_get fills 32 bytes from the deterministic PRNG -

Deno.test('WasiShim: random_get(32) uses the deterministic PRNG', async (t) => {
  const shimBytes = await loadShim();
  const progBytes = await loadFixture('wasi_random_32');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: progBytes });
  // Seed is SHA-256(contract_hash || u64-LE counter); contract_hash is 32 zero
  // bytes (from baseMock); counter starts at 0. So the first 32 bytes are
  // exactly SHA-256(0x00 × 32 || 0x00 × 8). Compute the expected value once
  // and assert byte-for-byte.
  const seed = new Uint8Array(40); // 32 zero seed bytes + 8 zero counter bytes
  const expected = new Uint8Array(
    await crypto.subtle.digest('SHA-256', seed),
  );
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    sequence: [],
    afterRun: (memories) => {
      const actual = programBytes(memories, 100, 32);
      assertEquals(actual, expected);
    },
  });
});

// -- Fixture: real wasi-libc-compiled C program ----------------------
//
// `wasi_libc_probe.wasm` was built by:
//   /opt/wasi-sdk/.../clang --target=wasm32-wasi --sysroot=... -Os probe.c
// where probe.c does `clock_gettime(CLOCK_REALTIME, ...)` then returns from
// main. The wasi-libc startup wraps the return value in proc_exit(0), which
// the shim surfaces with the magic exit-zero rejection. Verifies the shim's
// call signatures match what real wasi-libc emits.

Deno.test('WasiShim: real wasi-libc program (clock_gettime + return 0)', async (t) => {
  const shimBytes = await loadShim();
  const progBytes = await loadFixture('wasi_libc_probe');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: progBytes });
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    // wasi-libc's `_start` only calls proc_exit on a nonzero return from
    // main; return-0 falls through and the shim's `run` exits cleanly.
    // Verified by `wasm2wat probe.wasm | grep -A20 _start` -- the call to
    // __wasi_proc_exit is inside `if (rc != 0)`.
    sequence: [],
  });
});

// -- "hello world" C program (printf) — captures the batch-2 gap ----
//
// Real wasi-libc hello-world imports `fd_write`, `fd_close`,
// `fd_fdstat_get`, `fd_seek`, `proc_exit`. Batch 1 implements only
// `proc_exit`; the others return ENOTSUP. wasi-libc's printf path
// observes the ENOTSUP from fd_fdstat_get + fd_write and silently drops
// the output -- main still returns 0 from a successful `printf` return,
// so the shim's `run` returns normally. Captures the trace verbatim so
// when batch 2 lands fd_write etc. the snapshot diff documents what
// changed (in particular: where the bytes go).

Deno.test('WasiShim: hello-world C program runs through stubbed fd_* path (batch-2 gap)', async (t) => {
  const shimBytes = await loadShim();
  const progBytes = await loadFixture('wasi_libc_hello');
  const c = buildWasiContract({ shimWasm: shimBytes, programWasm: progBytes });
  await assertContractTraceSnapshot(t, {
    records: c.records,
    blobs: c.blobs,
    mock: baseMock(),
    sequence: [],
  });
});

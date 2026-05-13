// End-to-end shakedown: run the unmodified `quickjs-ng/quickjs` v0.14.0 CLI
// (qjs-wasi.wasm) through the WASI shim and pin the resulting contract trace
// as a snapshot.
//
// This is the Phase F deliverable from PLAN.md. The shim itself was driven by
// hand-authored .wat fixtures in tests/WasiShim.test.ts; this test proves the
// shim works against a real WASI preview1 binary (1.43 MiB, 23 distinct WASI
// imports) without source modifications.
//
// Vendoring:
//   - The qjs-wasi.wasm binary lives in tests/vendor/quickjs/ (gitignored).
//   - Run `deno task vendor:quickjs` to fetch it; the script verifies SHA-256
//     against the pinned value in docs/design/wasi-programs.md.
//   - If the binary is missing, the test logs a hint and skips so CI without
//     network still passes.
//
// First run: pass `-- --update` to deno test to generate the snapshot. The
// snapshot is large (hundreds of lines) -- that's expected. QuickJS does
// substantial WASI startup traffic (args/env, prestat scan, fd_fdstat_get
// on stdio) before reaching `print('hello world')`. The snapshot is the
// reference for "QuickJS still boots correctly through the shim."
//
// Setup:
//   - argv: ['qjs', '-e', "print('hello world');"]  -- one-liner eval, no FS.
//   - env: omitted (QuickJS reads no env vars for `-e`).
//   - preopens: omitted -- `-e` doesn't touch the FS, but the shim's defaults
//     (/in /out /scratch /dev) are fine to keep; QuickJS just sees them and
//     moves on. Forcing `preopens: []` is also valid (and matches the design
//     doc's example) but the defaults exercise the prestat path more, which
//     is closer to "real" WASI startup behaviour.
//   - stdin/stdout/stderr default to /dev/null and /out/debug respectively;
//     `print(...)` lands in the debug stream as a `host_call`.
//
// proc_exit(0) interaction: same as the WAT fixtures -- the shim rejects
// with EXIT_ZERO_REASON, contractSnapshot's MockSequenceEnv recognises it
// and converts to a clean `< exit ok` tail. No `reject` step is required.

import { Hash } from '../src/util/Hash.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { assertContractTraceSnapshot, type MockTable } from './helpers/contractSnapshot.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { loadQuickJs } from './helpers/loadQuickJs.ts';
import { buildContractRecords, type WasiSetup } from '../src/contracts/wasi-shim/setup.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Pinned hash for this test. As with WasiShim.test.ts the shim's PRNG seeds
// from H(block_hash || contract_hash); pinning keeps the trace stable.
const FIXED_CONTRACT_HASH = Hash.digest('quickjs-shakedown');

// `print('hello world');` exercises stdout via QuickJS's print builtin,
// which feeds into wasi-libc's fd_write(1, ...). The semicolon is canonical
// QuickJS-NG style for `-e` scripts.
const PROGRAM = "print('hello world');";

const SETUP: WasiSetup = {
  argv: ['qjs', '-e', PROGRAM],
  // No env, no preopen overrides, no stdio overrides -- defaults apply.
  // /out/debug is the default stdout sink, so `print(...)` reaches our
  // mock env's `debug` method as a host_call.
};

Deno.test('WasiShim - QuickJS shakedown: print("hello world")', async (t) => {
  let programBytes: Uint8Array;
  try {
    programBytes = await loadQuickJs();
  } catch (err) {
    // Skip cleanly on networkless CI / fresh checkout. The error message
    // points at `deno task vendor:quickjs`. We deliberately do NOT silently
    // pass: the step shows up as `step.ignored` in the test output so
    // someone notices.
    const msg = err instanceof Error ? err.message : String(err);
    await t.step({
      name: `skipped: ${msg}`,
      ignore: true,
      fn: () => {},
    });
    return;
  }

  const shimBytes = await loadWasiShim();
  const { records, blobs } = buildContractRecords({
    shimBytes,
    programBytes,
    setup: SETUP,
  });

  const wasiSetupBytes = records.wasi_setup as Uint8Array;
  const mock: MockTable = {
    mode: ExecutionMode.Verification,
    contractHash: FIXED_CONTRACT_HASH,
    params: utf8(''),
    timestamp: 0,
    contract_metadata: { value: 0, body: wasiSetupBytes },
    // Absorb stdout/stderr (default /out/debug) and any host-bridge logging.
    debug: null,
  };

  await assertContractTraceSnapshot(t, {
    records,
    blobs,
    mock,
    // No reject step -- QuickJS exits 0 via proc_exit(0), which the mock env
    // routes to `< exit ok` via the EXIT_ZERO_REASON sentinel.
    sequence: [],
  });
});

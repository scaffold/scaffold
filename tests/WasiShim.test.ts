// Contract-trace snapshot tests for the WASI shim. One test per .wat fixture
// in tests/fixtures/wasm/wasi/. Each fixture stresses one (or a small number
// of) WASI snapshot preview 1 host calls; the test pins the shim's downstream
// behaviour (scaffold_env host calls + cross-memory forwarder hops) into a
// snapshot file.
//
// First run: `deno task test:wasi -- --update` (or
// `deno test --allow-all tests/WasiShim.test.ts -- --update`). Subsequent
// runs verify the snapshot bit-for-bit.
//
// Mocking strategy:
//   - `contract_metadata` is mocked to return the wasi_setup body that
//     `buildContractRecords` would have placed on the contract block. The
//     snapshot helper bypasses ContractHost/plugin lookup, so the shim's
//     `setup.read` would otherwise have nothing to read.
//   - `debug: null` absorbs all /out/debug writes (stdout/stderr default to
//     this sink) plus any host-bridge logging for missing-metadata paths.
//   - `mode`, `params`, `timestamp`, `contractHash` are pinned to fixed
//     values so the trace is stable across runs / machines.
//
// `proc_exit(0)` interaction: the shim rejects with `EXIT_ZERO_REASON`, which
// `tests/helpers/contractSnapshot.ts` recognises and converts to `exit_ok`.
// Tests for clean-exit fixtures therefore omit any `reject` step from the
// sequence -- the trace tail will read `< exit ok`.

import { Hash } from '../src/util/Hash.ts';
import { ExecutionMode } from '../src/core/ContractEnv.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import {
  assertContractTraceSnapshot,
  type MockTable,
  type SequenceStep,
} from './helpers/contractSnapshot.ts';
import { loadWasiShim } from './helpers/loadWasiShim.ts';
import { buildContractRecords, type WasiSetup } from '../src/contracts/wasi-shim/setup.ts';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// Fixed contract hash used for every test. The shim's PRNG seeds from
// `H(block_hash || contract_hash)`; pinning this keeps random_get's output
// stable across runs.
const FIXED_CONTRACT_HASH = Hash.digest('wasi-shim-test-contract');

async function loadFixtureBytes(name: string): Promise<Uint8Array> {
  const url = new URL(`./fixtures/wasm/wasi/${name}.wasm`, import.meta.url);
  return await Deno.readFile(url);
}

interface RunOpts {
  fixture: string;
  setup?: WasiSetup;
  /** Per-test mock overrides on top of the defaults. */
  mock?: Partial<MockTable>;
  sequence: readonly SequenceStep[];
}

/**
 * Shared per-test runner. Loads shim + fixture, builds the contract records
 * via the production `buildContractRecords`, and feeds the encoded
 * `wasi_setup` bytes back through `contract_metadata` so the shim's
 * `setup.read` sees the same body it would on a real block.
 */
async function runShimSnapshot(t: Deno.TestContext, opts: RunOpts): Promise<void> {
  const shimBytes = await loadWasiShim();
  const programBytes = await loadFixtureBytes(opts.fixture);
  const { records, blobs } = buildContractRecords({
    shimBytes,
    programBytes,
    setup: opts.setup,
  });

  const wasiSetupBytes = records.wasi_setup as Uint8Array;
  // The shim's `setup.read` calls `env.contractMetadata` exactly once. Reply
  // shape mirrors a real `request_body`/`contract_metadata` reply: i128 LE
  // value + u32 LE body length + body. The bridge wraps that around the
  // bytes returned here. Empty body => shim falls through to defaults.
  const baseMock: MockTable = {
    mode: ExecutionMode.Verification,
    contractHash: FIXED_CONTRACT_HASH,
    params: utf8(''),
    timestamp: 0,
    contract_metadata: { value: 0, body: wasiSetupBytes },
    // Absorb stdout/stderr writes (default to /out/debug) and any
    // host-bridge debug logging. /out/debug routes via env.debug.
    debug: null,
  };
  const mock: MockTable = { ...baseMock, ...opts.mock };

  await assertContractTraceSnapshot(t, {
    records,
    blobs,
    mock,
    sequence: opts.sequence,
  });
}

// -- Tests ------------------------------------------------------------------

Deno.test('WasiShim - proc_exit(0): clean termination', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_proc_exit_ok',
    sequence: [],
  });
});

Deno.test('WasiShim - proc_exit(7): rejects with reason', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_proc_exit_fail',
    sequence: [
      { type: 'reject', expect: { reason: 'WASI proc_exit: 7' } },
    ],
  });
});

Deno.test('WasiShim - fd_write to stdout: routes to /out/debug as debug call', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_fd_write_stdout',
    sequence: [],
  });
});

Deno.test(
  'WasiShim - fd_write to /out/record/foo: emits Output{RECORD_CONTRACT, params="foo"}',
  async (t) => {
    await runShimSnapshot(t, {
      fixture: 'wasi_fd_write_record',
      sequence: [
        {
          type: 'emit_output',
          expect: {
            verifier: { contract: RECORD_CONTRACT, params: utf8('foo') },
            value: 0,
            body: utf8('hello'),
          },
        },
      ],
    });
  },
);

Deno.test('WasiShim - fd_read from /in/params: returns mocked params bytes', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_fd_read_params',
    mock: { params: utf8('hello-from-params') },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('echo') },
          value: 0,
          body: utf8('hello-from-params'),
        },
      },
    ],
  });
});

Deno.test('WasiShim - clock_time_get(REALTIME): returns timestamp x 1e6 ns', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_clock_realtime',
    mock: { timestamp: 1234 },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('clock') },
          value: 0,
          // 1234 * 1_000_000 = 1_234_000_000 = 0x498D5880 -> LE u64.
          body: new Uint8Array([0x80, 0x58, 0x8d, 0x49, 0, 0, 0, 0]),
        },
      },
    ],
  });
});

Deno.test('WasiShim - clock_time_get(MONOTONIC): counter advances 1 ns per call', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_clock_monotonic',
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('mono') },
          value: 0,
          // Body left for snapshot to pin: design says "starts at 0,
          // advances 1 ns per call". The exact pre/post-increment choice
          // is captured by the snapshot.
        },
      },
    ],
  });
});

Deno.test('WasiShim - random_get(8): emits deterministic PRNG bytes', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_random',
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('rng') },
          value: 0,
          // Body intentionally unspecified -- snapshot pins the PRNG output
          // for FIXED_CONTRACT_HASH.
        },
      },
    ],
  });
});

Deno.test('WasiShim - args_get: returns wasi_setup.argv[0]', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_args',
    setup: { argv: ['asc0123'] },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('argv0') },
          value: 0,
          body: utf8('asc0123'),
        },
      },
    ],
  });
});

Deno.test('WasiShim - environ_get: returns wasi_setup.env[0] as KEY=VALUE', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_environ',
    setup: { env: { FOO: 'bar' } },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('env0') },
          value: 0,
          body: utf8('FOO=bar'),
        },
      },
    ],
  });
});

Deno.test('WasiShim - path_open round-trip on /scratch: writes then reads back', async (t) => {
  await runShimSnapshot(t, {
    fixture: 'wasi_path_open_then_read',
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('scratch_byte') },
          value: 0,
          body: utf8('X'),
        },
      },
    ],
  });
});

Deno.test('WasiShim - fd_readdir on root: enumerates preopens', async (t) => {
  // The fixture readdirs fd=3 (root) and writes to /out at fd=4. So /
  // must be the first preopen and /out the second.
  await runShimSnapshot(t, {
    fixture: 'wasi_fd_readdir',
    setup: { preopens: ['/', '/out'] },
    sequence: [
      {
        type: 'emit_output',
        expect: {
          verifier: { contract: RECORD_CONTRACT, params: utf8('dirents') },
          value: 0,
          // Body left for snapshot: the root's enumeration order is owned
          // by the shim's vfs and the snapshot pins it.
        },
      },
    ],
  });
});

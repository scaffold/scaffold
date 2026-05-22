// Protocol spec: docs/protocol/wasm-abi.md#host-import-surface

import { Hash } from '../../util/Hash.ts';
import { type MaybePromise, maybeThen } from '../../util/MaybePromise.ts';
import { type ContractEnv, ContractRejection } from '../../core/ContractEnv.ts';
import type { BuilderHost, ValueDescriptor, WalkerHost } from '../../contracts/Contract.ts';
import type { Output, Verifier } from '../../core/BlockCreationModule.ts';
import {
  decodeOutput,
  decodeOutputList,
  decodeVerifier,
  encodeClaim,
  encodeClaimList,
  encodeValueAndBody,
} from './WasmWireCodec.ts';

/**
 * Empty-bytes reply the bridge returns from `contractMetadata` when the
 * typed env threw `ContractRejection`. The WASI shim's setup.read peels
 * the value/body header and falls through to defaults on either a
 * truncated reply or a present-but-empty body, so this single empty
 * encoding covers both "no matching record" and "present record with
 * empty body" with the design's intended behaviour. Non-WASM callers go
 * through the typed `ContractEnv.contractMetadata`, which keeps its
 * strict-throws contract.
 */
const EMPTY_METADATA_REPLY: Uint8Array = new Uint8Array(0);

// -- Run bridge ---------------------------------------------------

/**
 * Per-import handler set for the `scaffold_env.*` namespace.
 *
 * Each handler takes already-unmarshalled args (bytes / numbers / strings)
 * and returns already-encoded results (bytes / numbers). The transport is
 * responsible for everything else: reading WASM-memory args at `(ptr, len)`,
 * allocating the contract-side result region via `$alloc`, copying bytes,
 * and packing pointers.
 *
 * Return types are `MaybePromise` to mirror `ContractEnv`: callers that
 * have a sync env (e.g. `VerifyingEnv` under `InProcessMockTransport`)
 * see synchronous values; async envs return Promises.
 */
export interface RunBridge {
  mode(): number;
  contractHash(): Uint8Array;
  /**
   * Returns an empty `Uint8Array` when the typed env signalled "no matching
   * record" via `ContractRejection`. The WASI shim's setup.read treats a
   * truncated/empty reply as "use defaults", so the two cases (absent
   * record vs present-with-empty-body) intentionally collapse on the wire.
   */
  contractMetadata(verifierBytes: Uint8Array): MaybePromise<Uint8Array>;
  params(): Uint8Array;
  timestamp(): bigint;
  claimNext(): MaybePromise<Uint8Array>;
  claimAll(limit: number): MaybePromise<Uint8Array>;
  send(outputBytes: Uint8Array): void;
  request(verifierBytes: Uint8Array): MaybePromise<Uint8Array>;
  fetch(verifierBytes: Uint8Array, key: Uint8Array): MaybePromise<Uint8Array>;
  put(verifierBytes: Uint8Array, recordsBytes: Uint8Array): MaybePromise<void>;
  sign(pubkey: Uint8Array): void;
  /** Diagnostic-only sink for `/out/debug` writes from the WASI shim. */
  debug(messageBytes: Uint8Array): void;
  /** Throws ContractRejection. The transport translates that to a WASM trap. */
  reject(reason: Uint8Array): never;
}

export function makeRunBridge(env: ContractEnv): RunBridge {
  const decodeV = (bytes: Uint8Array): Verifier => decodeVerifier(bytes).value;
  const decodeO = (bytes: Uint8Array): Output => decodeOutput(bytes).value;
  const decodeOList = (bytes: Uint8Array): Output[] => decodeOutputList(bytes).value;

  return {
    mode: () => env.mode,

    contractHash: () => env.contractHash().toBytes(),

    // The shim's contract for missing-record handling: a `ContractRejection`
    // from the typed env converts to an empty `Uint8Array` reply (transports
    // pack it as `(ptr, len=0)`). The shim's `setup.read` falls through to
    // defaults on either an empty reply or a present-but-empty body, so we
    // don't need a separate "absent" sentinel on the wire. Observability of
    // the conversion runs through `env.debug` (best-effort) so the bridge
    // stays logger-free per scaffold's transport boundary.
    contractMetadata: (verifierBytes) => {
      const onMissing = (err: unknown): Uint8Array => {
        if (err instanceof ContractRejection) {
          env.debug?.(`contract_metadata: missing record (${err.message})`);
          return EMPTY_METADATA_REPLY;
        }
        throw err;
      };
      let reply: MaybePromise<{ value: number; body: Uint8Array }>;
      try {
        reply = env.contractMetadata(decodeV(verifierBytes));
      } catch (err) {
        return onMissing(err);
      }
      if (reply instanceof Promise) {
        return reply.then(
          (r) => encodeValueAndBody(r.value, r.body),
          onMissing,
        );
      }
      return encodeValueAndBody(reply.value, reply.body);
    },

    params: () => env.params(),

    timestamp: () => BigInt(env.timestamp()),

    claimNext: () => maybeThen(env.claimNext(), encodeClaim),

    claimAll: (limit) => maybeThen(env.claimAll(limit < 0 ? undefined : limit), encodeClaimList),

    send: (outputBytes) => {
      const output = decodeO(outputBytes);
      env.send(output.verifier, output.value, output.body);
    },

    request: (verifierBytes) =>
      maybeThen(
        env.request(decodeV(verifierBytes)),
        (r) => encodeValueAndBody(r.value, r.body),
      ),

    fetch: (verifierBytes, key) => env.fetch(decodeV(verifierBytes), key),

    put: (verifierBytes, recordsBytes) => {
      // Wire format still carries an Output[]; convert to the
      // {key -> body} shape that env.put now expects. TODO(@joel): make
      // the WASM wire format records-shaped directly once put is wired
      // through the generator pipeline.
      const outputs = decodeOList(recordsBytes);
      const records: Record<string, Uint8Array | string> = {};
      const td = new TextDecoder();
      for (const o of outputs) {
        const key = td.decode(o.verifier.params);
        records[key] = o.body ?? new Uint8Array(0);
      }
      return env.put(decodeV(verifierBytes), records);
    },

    sign: (pubkey) => {
      env.sign(pubkey);
    },

    debug: (messageBytes) => {
      // Best-effort diagnostic sink. Envs that don't implement `debug` get
      // their writes swallowed -- this matches the design's "diagnostic-only"
      // promise and keeps `/out/debug` from trapping when no logger is wired.
      if (env.debug) {
        env.debug(new TextDecoder().decode(messageBytes));
      }
    },

    reject: (reason) => {
      const message = new TextDecoder().decode(reason);
      throw new ContractRejection(message);
    },
  };
}

// -- Walk bridge --------------------------------------------------

/**
 * `scaffold_walker.*` handler set. Args arrive already unmarshalled (UTF-8
 * decoded, JSON-decoded for descriptors). The transport extracts strings
 * from contract memory before calling.
 */
export interface WalkBridge {
  emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void;
  emitString(key: string, value: string, desc: ValueDescriptor): void;
  emitNumber(key: string, value: number, desc: ValueDescriptor): void;
  emitBool(key: string, value: boolean, desc: ValueDescriptor): void;
  emitMapStart(key: string): boolean;
  emitMapEnd(): void;
  emitListStart(key: string, count: number): boolean;
  emitListEnd(): void;
}

export function makeWalkBridge(host: WalkerHost): WalkBridge {
  return {
    emitBytes: (key, value, desc) => host.emitBytes(key, value, desc),
    emitString: (key, value, desc) => host.emitString(key, value, desc),
    emitNumber: (key, value, desc) => host.emitNumber(key, value, desc),
    emitBool: (key, value, desc) => host.emitBool(key, value, desc),
    emitMapStart: (key) => host.emitMapStart(key),
    emitMapEnd: () => host.emitMapEnd(),
    emitListStart: (key, count) => host.emitListStart(key, count),
    emitListEnd: () => host.emitListEnd(),
  };
}

// -- Build bridge -------------------------------------------------

/**
 * `scaffold_builder.*` handler set. The byte/string requesters return
 * already-encoded results (UTF-8 for strings); the transport allocates and
 * copies into contract memory.
 */
export interface BuildBridge {
  requestBytes(key: string, desc: ValueDescriptor): Uint8Array;
  /** Returns UTF-8 encoded bytes of the user-supplied string. */
  requestString(key: string, desc: ValueDescriptor): Uint8Array;
  requestNumber(key: string, desc: ValueDescriptor): number;
  requestBool(key: string, desc: ValueDescriptor): number;
  requestArrayLength(key: string, desc: ValueDescriptor): number;
  beginObject(key: string): void;
  endObject(): void;
  beginArray(key: string): void;
  endArray(): void;
  validationError(key: string, message: string): void;
}

export function makeBuildBridge(host: BuilderHost): BuildBridge {
  const encoder = new TextEncoder();
  return {
    requestBytes: (key, desc) => host.requestBytes(key, desc),
    requestString: (key, desc) => encoder.encode(host.requestString(key, desc)),
    requestNumber: (key, desc) => host.requestNumber(key, desc),
    requestBool: (key, desc) => host.requestBool(key, desc) ? 1 : 0,
    requestArrayLength: (key, desc) => host.requestArrayLength(key, desc),
    beginObject: (key) => host.beginObject(key),
    endObject: () => host.endObject(),
    beginArray: (key) => host.beginArray(key),
    endArray: () => host.endArray(),
    validationError: (key, message) => host.validationError(key, message),
  };
}

// -- Helpers ------------------------------------------------------

/** Parse a UTF-8 JSON-encoded `ValueDescriptor`. Throws if malformed. */
export function parseValueDescriptor(bytes: Uint8Array): ValueDescriptor {
  const text = new TextDecoder().decode(bytes);
  return JSON.parse(text) as ValueDescriptor;
}

// Re-exported so transports that need to forge hashes for tests can
// construct them without extra imports.
export { Hash };

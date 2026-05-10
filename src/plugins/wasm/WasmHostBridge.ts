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
  contractMetadata(verifierBytes: Uint8Array): MaybePromise<Uint8Array>;
  params(): Uint8Array;
  timestamp(): bigint;
  claimNext(): MaybePromise<Uint8Array>;
  claimAll(limit: number): MaybePromise<Uint8Array>;
  emitOutput(outputBytes: Uint8Array): void;
  requestBody(verifierBytes: Uint8Array): MaybePromise<Uint8Array>;
  fetch(verifierBytes: Uint8Array, key: Uint8Array): MaybePromise<Uint8Array>;
  fork(verifierBytes: Uint8Array, recordsBytes: Uint8Array): MaybePromise<void>;
  sign(pubkey: Uint8Array): void;
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

    contractMetadata: (verifierBytes) =>
      maybeThen(
        env.contractMetadata(decodeV(verifierBytes)),
        (r) => encodeValueAndBody(r.value, r.body),
      ),

    params: () => env.params(),

    timestamp: () => BigInt(env.timestamp()),

    claimNext: () => maybeThen(env.claimNext(), encodeClaim),

    claimAll: (limit) => maybeThen(env.claimAll(limit < 0 ? undefined : limit), encodeClaimList),

    emitOutput: (outputBytes) => {
      const output = decodeO(outputBytes);
      env.emitOutput(output.verifier, output.value, output.body);
    },

    requestBody: (verifierBytes) =>
      maybeThen(
        env.requestBody(decodeV(verifierBytes)),
        (r) => encodeValueAndBody(r.value, r.body),
      ),

    fetch: (verifierBytes, key) => env.fetch(decodeV(verifierBytes), key),

    fork: (verifierBytes, recordsBytes) =>
      env.fork(decodeV(verifierBytes), decodeOList(recordsBytes)),

    sign: (pubkey) => {
      env.sign(pubkey);
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

// The one place the WASM ABI is written down.
//
// Each transport used to re-declare all of this (flatRunExports /
// flatWalkExports / flatBuildExports, x3). None of it is transport-specific --
// it is names, arities, and which calls may block. Adding an entry point (the
// pre-claim step of wp 9.2, say) is now a table here rather than three method
// implementations.

import { todo } from '../../util/functional.ts';
import { ContractEnv } from '../env/ContractEnv.ts';
import { hostFn, HostImports } from './WasmTransport.ts';

/**
 * `scaffold_env.*` -- the contract surface, identical under generation and
 * verification. The env is the only thing bound in here; the transport that
 * wires this table never sees it.
 *
 * No `mode` import: a contract that can observe which mode it is in can
 * produce a non-unique result, so the distinction stays on the host side.
 */
export function runImports(env: ContractEnv): HostImports {
  return {
    contract_hash: hostFn([], 'bytes', false, () => env.contractHash().toBytes()),

    params: hostFn([], 'bytes', false, () => env.params()),

    // ContractRejection here means "no such record"; the shim reads a
    // zero-length reply as "use defaults", so absent and present-but-empty
    // collapse on the wire.
    contract_metadata: hostFn(['bytes'], 'bytes', true, (_predicate) => {
      // decodePredicate -> env.contractMetadata -> encode (amount, data)
      return todo();
    }),

    claim_next: hostFn([], 'bytes', true, () => {
      // encodeClaim(env.claimNext())
      return todo();
    }),

    // limit < 0 encodes "no limit".
    claim_all: hostFn(['i32'], 'bytes', true, (_limit) => {
      // encodeClaimList(env.claimAll(limit < 0 ? undefined : limit))
      return todo();
    }),

    emit_output: hostFn(['bytes'], 'void', false, (_output) => {
      // decodeOutput -> env.send(predicate, amount, data)
      return todo();
    }),

    set_result: hostFn(['bytes'], 'void', false, (data) => env.setResult(data)),

    get_result: hostFn([], 'bytes', true, () => {
      // env.getResult()
      return todo();
    }),

    fetch: hostFn(['bytes'], 'bytes', true, (_predicate) => {
      // decodePredicate -> env.fetch
      return todo();
    }),

    put: hostFn(['bytes', 'bytes'], 'bytes', true, (_predicate, _data) => {
      // decodePredicate -> env.put -> hash.toBytes()
      // v1 wired put as void and discarded the hash; the returned hash is
      // what makes a put-dependent result re-verifiable, so it is a result
      // here.
      return todo();
    }),

    sign: hostFn(['bytes'], 'void', false, (pubkey) => {
      // env.sign(pubkey)
      return todo();
    }),

    timestamp_gte: hostFn(['i64'], 'void', false, (instant) => {
      // env.timestampGte(Number(instant))
      return todo();
    }),

    // Diagnostic only; never traps, and silently drops when the env has no sink.
    debug: hostFn(['str'], 'void', false, (message) => {
      // env.debug?.(message)
      return todo();
    }),

    // The transport turns the throw into a guest trap.
    reject: hostFn(['str'], 'void', false, (reason) => {
      throw new Error(reason);
    }),
  };
}

// `scaffold_walker.*` and `scaffold_builder.*` port over unchanged in shape --
// the existing tables (see the flatWalkExports / flatBuildExports in the v1
// transports) become two more functions here, each returning HostImports over
// a WalkerHost and a Reader-backed cursor respectively. Left out until the
// run path lands, so there is only one table to keep honest meanwhile.

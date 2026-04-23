// Protocol spec: docs/protocol/contracts.md
//
// Demo "Hello, {name}" request/reply contract. Not a protocol contract --
// lives here so demos and tests can share the same well-known hash.

import { Hash } from '../util/Hash.ts';
import { RECORD_CONTRACT } from '../core/Block.ts';
import type { Contract } from './Contract.ts';
import type { Output, Verifier } from '../core/BlockCreationModule.ts';

/** Well-known contract hash for the demo hello contract. */
export const HELLO_CONTRACT: Hash = Hash.digest('scaffold:demo:hello');

/**
 * The hello contract: consumes one request output whose verifier params
 * are a UTF-8 name, and emits a self-claimed RECORD_CONTRACT output
 * under key "response" with data "Hello, {name}".
 *
 * Both request and response sit on the responding block. The requester's
 * block carries only the request output -- the responder claims it and
 * produces the record output here.
 */
export const helloContract: Contract = {
  outputNamespaces: [RECORD_CONTRACT],

  async run(env) {
    await env.requireInput();
    const name = new TextDecoder().decode(env.getParams());
    const response = new TextEncoder().encode(`Hello, ${name}`);
    env.requireResult(new TextEncoder().encode('response'), response);
  },
};

/** Build a verifier for a hello request keyed on `name`. */
export function helloVerifier(name: string): Verifier {
  return {
    contract: HELLO_CONTRACT,
    params: new TextEncoder().encode(name),
  };
}

/** Build a hello request output worth `value` (must be > 0 to be routed). */
export function makeHelloRequest(name: string, value: number): Output {
  return {
    verifier: helloVerifier(name),
    value,
    data: new Uint8Array(0),
  };
}

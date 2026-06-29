// Protocol spec: docs/protocol/contracts.md
//
// Demo "Hello, {name}" request/reply contract. Not a protocol contract --
// lives here so demos and tests can share the same well-known hash.

import { Hash } from '../util/Hash.ts';
import type { Contract } from './Contract.ts';
import type { Output, Verifier } from '../core/BlockCreationModule.ts';
import { readString } from '../interfaces/Reader.ts';
import { str2bin } from '../util/buffer.ts';

/** Well-known contract hash for the demo hello contract. */
export const HELLO_CONTRACT: Hash = Hash.digest('scaffold:demo:hello');

/**
 * The hello contract: claims one incentive output whose verifier params
 * are a UTF-8 name, and emits a self-claimed ANSWER output under its own
 * verifier `{ HELLO_CONTRACT, name }` with data "Hello, {name}" (the
 * data-based result model -- see docs/protocol/results.md).
 *
 * Both incentive and answer sit under the same verifier. The requester's
 * block carries the incentive output; the responder claims it and
 * self-claims the answer here. `claimNext` consumes the external incentive
 * (value>0, not a self-claim); the zero-value answer self-claim is excluded.
 */
export const helloContract: Contract = {
  outputNamespaces: [HELLO_CONTRACT],

  async run(env) {
    await env.claimNext();
    const name = new TextDecoder().decode(env.params());
    const response = new TextEncoder().encode(`Hello, ${name}`);
    env.setResult(response);
  },

  async buildParams(reader) {
    const name = await readString(await reader(''), 'name', {
      type: 'string',
      shortDescription: 'Your name',
    });
    return str2bin(name);
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
    body: new Uint8Array(0),
  };
}

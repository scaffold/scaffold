// End-to-end: a contract calls `env.getOutput(verifier)` in generation mode
// and no handler returns non-null yet. The generator must park on a queue
// and resume when a handler is later registered that returns non-null.

import { assert, assertEquals } from '@std/assert';
import { Hash } from '../src/util/Hash.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { composeGenesisPacket } from '../src/core/Block.ts';
import { makeSignatureOutput } from '../src/contracts/SignatureContract.ts';
import { secp } from '../src/util/secp.ts';
import { RECORD_CONTRACT } from '../src/core/Block.ts';
import type { Contract } from '../src/contracts/Contract.ts';

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Contract: claims a single input, calls getOutput(RECORD/"prompt"),
 * mirrors the resolved bytes into a requireResult under the same key.
 */
const BLOCKING_CONTRACT = Hash.digest('scaffold:test:blocking-get-output');

const blockingContract: Contract = {
  outputNamespaces: [RECORD_CONTRACT],
  async run(env) {
    await env.requireInput();
    const slot = await env.getOutput({ contract: RECORD_CONTRACT, params: enc('prompt') });
    env.requireResult(enc('echo'), slot.data);
  },
};

Deno.test(
  'waitForGetOutput: generator parks when no handler matches, wakes on register',
  async () => {
    const priv = secp.utils.randomPrivateKey();
    const pub = secp.getPublicKey(priv, true);

    const genesis = composeGenesisPacket([makeSignatureOutput(pub, 1000)]);
    const scaffold = new Scaffold({
      privateKey: priv,
      genesis,
      enablePiggyback: false,
    });
    scaffold.registerContract(BLOCKING_CONTRACT, blockingContract);

    // Publish a block that has the BLOCKING_CONTRACT output as a new UTXO.
    // DraftStrategy sees the canonicality change and kicks off a generator;
    // the generator calls getOutput and parks because no handler is set.
    scaffold.put({
      outputs: [
        {
          verifier: { contract: BLOCKING_CONTRACT, params: new Uint8Array(0) },
          value: 0,
          data: enc('trigger'),
        },
      ],
    });

    // Give DraftStrategy time to start the generator. The getOutput call
    // inside the contract will park because no handler has been registered
    // yet.
    await new Promise((r) => setTimeout(r, 50));

    const gen = scaffold.context.generation;
    assert(
      gen.parkedGetOutputCount >= 1,
      'a generator should be parked in getOutput, got ' + gen.parkedGetOutputCount,
    );

    // Now register a handler. The parked generator should resume.
    scaffold.registerOutputHandler(BLOCKING_CONTRACT, async () => ({
      value: 0,
      data: enc('resolved-bytes'),
    }));

    // Allow the generator to resume and the resulting draft to solidify.
    await new Promise((r) => setTimeout(r, 100));

    assertEquals(gen.parkedGetOutputCount, 0);

    await scaffold.close();
  },
);

Deno.test(
  'waitForGetOutput: registered handler that returns null keeps generator parked',
  async () => {
    const priv = secp.utils.randomPrivateKey();
    const pub = secp.getPublicKey(priv, true);
    const genesis = composeGenesisPacket([makeSignatureOutput(pub, 1000)]);
    const scaffold = new Scaffold({
      privateKey: priv,
      genesis,
      enablePiggyback: false,
    });
    scaffold.registerContract(BLOCKING_CONTRACT, blockingContract);

    scaffold.put({
      outputs: [
        {
          verifier: { contract: BLOCKING_CONTRACT, params: new Uint8Array(0) },
          value: 0,
          data: enc('trigger'),
        },
      ],
    });

    await new Promise((r) => setTimeout(r, 50));
    const parkedBefore = scaffold.context.generation.parkedGetOutputCount;
    assert(parkedBefore >= 1, `expected parked >= 1, got ${parkedBefore}`);

    // Register a handler that says "not me" (returns null). Generator must
    // stay parked.
    scaffold.registerOutputHandler(BLOCKING_CONTRACT, async () => null);

    await new Promise((r) => setTimeout(r, 50));
    const parkedAfter = scaffold.context.generation.parkedGetOutputCount;
    assert(
      parkedAfter >= 1,
      `handler returning null must not wake parked generator; before=${parkedBefore} after=${parkedAfter}`,
    );

    await scaffold.close();
  },
);

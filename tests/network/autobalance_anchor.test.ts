/**
 * Regression test for the auto-balance anchoring bug.
 *
 * UtxoIndex stores each entry's extendedIndex as the output's local position
 * inside its producer block. NodeContext.autoBalance then uses that as the
 * claim index (`finalOutputCount + utxo.extendedIndex`) against the new
 * block's anchor extended vector. The two only coincide when the claimant
 * anchors directly to the producer; as soon as there's an intervening
 * anchor-chain hop whose own outputs or claims reshape the inherited
 * post-subtree vector, the claim points at the wrong slot.
 *
 * Repro: publish an intermediate block that self-claims its first own
 * output, then publish a funded block whose anchor is that intermediate.
 * Auto-balance picks the genesis signature UTXO (stored extendedIndex = 0)
 * and emits a claim at `own + 0`, which in the anchor's extended vector
 * points at the intermediate's surviving aggregation marker, not at the
 * genesis signature output. Throughput fails to balance and the funded
 * block never becomes canonical.
 */

import { assert } from '@std/assert';
import { Scaffold } from '../../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey } from '../../src/genesis.ts';
import { makeHelloRequest } from '../../src/contracts/HelloContract.ts';

Deno.test('autoBalance: claim resolves correctly when anchor is not the UTXO producer', () => {
  const genesis = computeDemoGenesis(['a']);
  const node = new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis,
    enableLogging: false,
  });

  // Intermediate block: self-claims its own first output. This removes
  // output 0 from the post-subtree vector that descendants inherit, so
  // the intermediate's extended layout differs from genesis's.
  const interim = node.put({
    outputs: [makeHelloRequest('interim', 1_000_000)],
    claims: [{ index: 0, value: 1_000_000 }],
  });
  assert(
    node.context.consensus.isCanonical(interim.hash),
    'interim must be canonical before the next put',
  );

  // Funded block: anchors to the interim (the canonical tip). auto-balance
  // must fund the 1000 output from genesis's signature UTXO. The claim
  // index it emits has to resolve to that UTXO in the interim's extended
  // vector, not to some other slot.
  const funded = node.put({
    outputs: [makeHelloRequest('world', 1_000)],
  });

  assert(
    node.context.consensus.isCanonical(funded.hash),
    `funded block should be canonical after auto-balance (hash ${
      funded.hash.toHex().slice(0, 10)
    })`,
  );
});

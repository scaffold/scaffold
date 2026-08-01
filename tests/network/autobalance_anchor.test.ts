/**
 * Regression test for the auto-balance anchoring through an intervening
 * anchor-chain hop. UtxoIndex stores each entry's outputIndex as the
 * output's local position inside its producer block; autoBalance must
 * resolve that into a position in the post-subtree vector of whatever
 * anchor the new block ends up using.
 *
 * Setup:
 *  1. interim claims genesis's signature output and emits a fresh
 *     signature output (round-trips 1M coins). UtxoIndex now has
 *     interim.outputs[0] as the live signature UTXO; genesis's is spent.
 *  2. funded has no claims, so auto-balance must pull interim's sig
 *     UTXO (1M) to cover its 1000-value HelloRequest output. Because
 *     interim is the canonical tip and its own output is the only sig
 *     UTXO available, the claim index emitted by autoBalance has to
 *     resolve correctly against interim's extended vector.
 */

import { assert } from '@std/assert';
import { Scaffold } from '../../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey, demoPublicKey } from '../../src/graph/genesis.ts';
import { makeHelloRequest } from '../../src/contracts/HelloContract.ts';
import { makeSignatureOutput } from '../../src/contracts/SignatureContract.ts';
import { makeAggregationOutput } from '../../src/contracts/AggregationContract.ts';

Deno.test('autoBalance: claim resolves correctly when anchor is not the UTXO producer', async () => {
  const genesis = computeDemoGenesis(['a']);
  const node = new Scaffold({
    privateKey: demoPrivateKey('a'),
    genesis,
    enableLogging: false,
  });
  const pubkey = demoPublicKey('a');

  const draftManager = node.context.draftManager;

  // Interim: consume genesis's signature output, emit a fresh sig
  // output (round-trip 1M coins). Now interim's sig output is the only
  // signature UTXO in the index. Pair the input claim with the output
  // through DraftManager directly -- the narrow Scaffold.put only
  // publishes records under a verifier.
  const interimDraft = draftManager.addReady({
    claims: [{ producer: node.context.genesisHash, outputIndex: 0 }],
    outputs: [makeSignatureOutput(pubkey, 1_000_000), makeAggregationOutput()],
    declaredWeight: 1,
  });
  const interim = draftManager.solidify([interimDraft]);
  assert(interim.ok, 'interim must be created');
  assert(
    node.context.consensus.isCanonical(interim.block.hash),
    'interim must be canonical before the next put',
  );

  // Funded block: anchors to interim. autoBalance must resolve interim's
  // sig output via the anchor's extended vector, not via the producer's
  // local outputIndex.
  const fundedDraft = draftManager.addReady({
    claims: [],
    outputs: [makeHelloRequest('world', 1_000), makeAggregationOutput()],
    declaredWeight: 1,
  });
  const funded = draftManager.solidify([fundedDraft]);
  assert(funded.ok, 'funded must be created');
  assert(
    node.context.consensus.isCanonical(funded.block.hash),
    `funded block should be canonical after auto-balance (hash ${
      funded.block.hash.toHex().slice(0, 10)
    })`,
  );

  await node.close();
});

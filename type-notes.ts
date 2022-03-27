import Hash from './sbl/util/Hash.ts';

/*
Instead of determining the canonical answer to a question by comparing the derived work of each answer, just let the network do that. Provide a reward for rectifying the situation, and the network will choose the easiest answer to eliminate.
How is this reward specified? It’s a collateral pool, specified on every emitted answer, and distributed among every answer reachable from the root.
This is nice.
*/

interface Subscription {
  contractHash: Hash;
  params: Uint8Array;
}

interface Answer {
  data: Uint8Array;
  correctnessCollateral: number;
  uniquenessCollateral: number;
}

#!/usr/bin/env -S deno run --allow-all
/**
 * Generate the well-known genesis packet hex.
 *
 * Usage: deno task generate-genesis
 *
 * Outputs the hex string that should be pasted into src/genesis.ts
 * as the GENESIS_PACKET_HEX constant.
 */

import { bin2hex } from '../src/util/hex.ts';
import { computeGenesisBlock, WELL_KNOWN_KEYS } from '../src/genesis.ts';

const packet = computeGenesisBlock();
const hex = bin2hex(packet.raw);

// deno-lint-ignore no-console
console.log('Genesis packet hex:');
// deno-lint-ignore no-console
console.log(hex);
// deno-lint-ignore no-console
console.log(`\nGenesis hash: ${packet.hash.toHex()}`);
// deno-lint-ignore no-console
console.log(`Funded keys (${WELL_KNOWN_KEYS.length}):`);
for (const [i, k] of WELL_KNOWN_KEYS.entries()) {
  // deno-lint-ignore no-console
  console.log(`  [${i}] ${k.label}  pub=${bin2hex(k.publicKey)}`);
}

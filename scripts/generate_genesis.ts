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
import { makeSignatureOutput } from '../src/core/Block.ts';
import { composeGenesisPacket } from '../src/core/Packet.ts';
import { WELL_KNOWN_PUBLIC_KEY } from '../src/genesis.ts';

const outputs = [makeSignatureOutput(WELL_KNOWN_PUBLIC_KEY, 1_000_000)];
const { packet } = composeGenesisPacket(outputs);
const hex = bin2hex(packet.raw);

// deno-lint-ignore no-console
console.log('Genesis packet hex:');
// deno-lint-ignore no-console
console.log(hex);
// deno-lint-ignore no-console
console.log(`\nGenesis hash: ${packet.hash.toHex()}`);
// deno-lint-ignore no-console
console.log(`Block hash will be: ${packet.hash.toHex()}`);

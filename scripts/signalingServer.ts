#!/usr/bin/env -S deno run --allow-all
/**
 * Signaling hub for the two-browser chess demo.
 *
 * This is just a `Scaffold` node that speaks WebSocket server. Browser
 * tabs dial it via `scaffold.bootstrapConnection('websocket', ...)`;
 * once connected they use it to mesh-relay encrypted signaling payloads
 * and complete WebRTC handshakes with each other.
 *
 * Usage:
 *
 *   deno run --allow-all scripts/signalingServer.ts [--port 8314]
 *
 * See docs/design/chess-two-browser-demo.md for the broader setup.
 */

import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import { computeDemoGenesis, demoPrivateKey, demoPublicKey } from '../src/graph/genesis.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { bin2hex } from '../src/util/hex.ts';

const flags = parseArgs(Deno.args, { string: ['port'] });
const port = flags.port ? Number(flags.port) : 8314;

const DEMO_SEEDS = ['a', 'b', 'c'] as const;
const HUB_SEED = 'hub';

const scaffold = new Scaffold({
  privateKey: demoPrivateKey(HUB_SEED),
  genesis: computeDemoGenesis(DEMO_SEEDS),
  plugins: [new WebsocketServerTransport({ port })],
  enableLogging: false,
  // Hub forwards every block/signal/request it sees to every other
  // connected peer. Without this, brand-new chess blocks have no
  // claim-history-based path through the hub. See TODO.md "Baseline
  // propagation for cold-start".
  useFloodGossip: true,
  enablePiggyback: false,
});

scaffold.onPeerConnected((peerId) => {
  // deno-lint-ignore no-console
  console.log(`peer_connected ${peerId}`);
});
scaffold.onPeerDisconnected((peerId) => {
  // deno-lint-ignore no-console
  console.log(`peer_disconnected ${peerId}`);
});

scaffold.start();

// deno-lint-ignore no-console
console.log(`signaling hub listening ws://127.0.0.1:${port}/`);
// deno-lint-ignore no-console
console.log(`hub pubkey: ${bin2hex(demoPublicKey(HUB_SEED))}`);

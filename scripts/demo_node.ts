#!/usr/bin/env -S deno run --allow-all
/**
 * End-to-end request/reply demo node.
 *
 * Usage:
 *
 *   # Terminal B (middle / server):
 *   deno run --allow-all scripts/demo_node.ts --role server --seed b --port 8314
 *
 *   # Terminal C (resolver):
 *   deno run --allow-all scripts/demo_node.ts \
 *       --role client --seed c --bootstrap ws://127.0.0.1:8314/ --register hello
 *
 *   # Terminal A (requester):
 *   deno run --allow-all scripts/demo_node.ts \
 *       --role client --seed a --bootstrap ws://127.0.0.1:8314/
 *
 * Each process reads line-delimited commands on stdin and emits JSON
 * events on stdout.
 *
 * Commands (all nodes):
 *   connect <peerHex>                -- initiate authenticated handshake to peer
 *   seed                             -- (C only) publish a capability seed for HELLO
 *   hacky-send <blockHashHex> <peerHex>
 *                                    -- ship a stored block directly to a peer,
 *                                       bypassing gossip (bootstrap / demo tool)
 *   request <name>                   -- (A) publish a HELLO request for `name`
 *   expect <name>                    -- (A) subscribe to fetch() for HELLO:name
 *   peers                            -- list connected peer IDs
 *   quit                             -- shut down
 */

import { parseArgs } from '@std/cli/parse-args';
import { Scaffold } from '../src/Scaffold.ts';
import {
  computeDemoGenesis,
  demoPrivateKey,
  demoPublicKey,
} from '../src/genesis.ts';
import {
  HELLO_CONTRACT,
  helloContract,
  makeHelloRequest,
} from '../src/contracts/HelloContract.ts';
import { WebsocketServerTransport } from '../plugins/deno/WebsocketServerTransport.ts';
import { WebsocketClientTransport } from '../plugins/WebsocketClientTransport.ts';
import { TransportPlugin } from '../src/interfaces/transport.ts';
import { Hash } from '../src/util/Hash.ts';
import { hex2bin } from '../src/util/hex.ts';

// -- Args -------------------------------------------------------------

const flags = parseArgs(Deno.args, {
  string: ['role', 'seed', 'port', 'bootstrap', 'register'],
  default: { role: 'client', seed: 'a' },
});

const role = flags.role === 'server' ? 'server' : 'client';
const seed = String(flags.seed);
const port = flags.port ? Number(flags.port) : 8314;
const bootstrap = flags.bootstrap ? String(flags.bootstrap) : undefined;
const shouldRegisterHello = flags.register === 'hello';

// -- JSON emit --------------------------------------------------------

function emit(event: Record<string, unknown>): void {
  // deno-lint-ignore no-console
  console.log(JSON.stringify(event));
}

// -- Scaffold setup ---------------------------------------------------

const DEMO_SEEDS = ['a', 'b', 'c'] as const;
const genesis = computeDemoGenesis(DEMO_SEEDS);

const plugins: TransportPlugin[] = role === 'server'
  ? [new WebsocketServerTransport({ port })]
  : [new WebsocketClientTransport()];

const enableGeneration = shouldRegisterHello
  ? (h: Hash) => Hash.equals(h, HELLO_CONTRACT)
  : () => false;

const scaffold = new Scaffold({
  privateKey: demoPrivateKey(seed),
  genesis,
  plugins,
  enableGeneration,
  enableLogging: false,
});

if (shouldRegisterHello) {
  scaffold.registerContract(HELLO_CONTRACT, helloContract);
}

scaffold.onPeerConnected((peerId) => {
  emit({ type: 'peer_connected', peerId });
});
scaffold.onPeerDisconnected((peerId) => {
  emit({ type: 'peer_disconnected', peerId });
});

scaffold.start();

if (bootstrap) {
  scaffold.bootstrapConnection('websocket', bootstrap);
}

emit({
  type: 'started',
  role,
  seed,
  pubkey: scaffold.publicKeyHex,
  port: role === 'server' ? port : undefined,
  bootstrap,
  knownPeers: {
    a: toHex(demoPublicKey('a')),
    b: toHex(demoPublicKey('b')),
    c: toHex(demoPublicKey('c')),
  },
});

// -- Command loop ------------------------------------------------------

const reader = Deno.stdin.readable
  .pipeThrough(new TextDecoderStream())
  .getReader();
let buffer = '';
let seedHash: Hash | null = null;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      await handleCommand(line);
    } catch (err) {
      emit({ type: 'error', command: line, message: (err as Error).message });
    }
  }
}

async function handleCommand(line: string): Promise<void> {
  const parts = line.split(/\s+/);
  const cmd = parts[0];

  switch (cmd) {
    case 'connect': {
      const peerHex = parts[1];
      if (!peerHex) throw new Error('usage: connect <peerHex>');
      await scaffold.connectToPeer(hex2bin(peerHex));
      emit({ type: 'connect_initiated', peer: peerHex });
      break;
    }

    case 'seed': {
      const name = parts[1] ?? 'seed';
      const result = scaffold.put({
        outputs: [makeHelloRequest(name, 1_000_000)],
        claims: [{ index: 0, value: 1_000_000 }],
      });
      seedHash = result.hash;
      emit({
        type: 'seed_published',
        hash: result.hash.toHex(),
        name,
      });
      break;
    }

    case 'hacky-send': {
      const hashHex = parts[1];
      const peerHex = parts[2];
      if (!hashHex || !peerHex) {
        throw new Error('usage: hacky-send <blockHashHex> <peerHex>');
      }
      const hash = hashHex === 'seed'
        ? (seedHash ?? (() => {
          throw new Error('no seed published yet');
        })())
        : Hash.fromHex(hashHex);
      scaffold.sendBlockToPeer(hash, peerHex);
      emit({
        type: 'hacky_sent',
        block: hash.toHex(),
        peer: peerHex,
      });
      break;
    }

    case 'request': {
      const name = parts.slice(1).join(' ');
      if (!name) throw new Error('usage: request <name>');
      const result = scaffold.put({
        outputs: [makeHelloRequest(name, 1_000)],
      });
      emit({
        type: 'request_published',
        name,
        hash: result.hash.toHex(),
      });
      break;
    }

    case 'expect': {
      const name = parts.slice(1).join(' ');
      if (!name) throw new Error('usage: expect <name>');
      scaffold.fetch({
        contract: HELLO_CONTRACT,
        params: new TextEncoder().encode(name),
        onClaim: (c) => {
          if (!c) return;
          const data = new TextDecoder().decode(c.data);
          emit({
            type: 'fetch_result',
            name,
            block: c.block.hash.toHex(),
            data,
          });
        },
      });
      emit({ type: 'expect_subscribed', name });
      break;
    }

    case 'peers': {
      const peers: string[] = [];
      for (const id of scaffold.context.routing.getPeerIds()) peers.push(id);
      emit({ type: 'peers', peers });
      break;
    }

    case 'quit': {
      await scaffold.close();
      emit({ type: 'closed' });
      Deno.exit(0);
      break; // unreachable; satisfies no-fallthrough
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
}

function toHex(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, '0');
  return out;
}

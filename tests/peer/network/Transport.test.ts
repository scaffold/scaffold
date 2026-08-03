import { assert, assertEquals } from '@std/assert';
import { Context } from '../../../src/Context.ts';
import { BlockStore } from '../../../src/graph/BlockStore.ts';
import { DraftStore } from '../../../src/graph/DraftStore.ts';
import { AtomSource, Block } from '../../../src/graph/types.ts';
import { Gossip } from '../../../src/peer/network/Gossip.ts';
import { Transport } from '../../../src/peer/network/Transport.ts';
import { neverAbort } from '../../../src/util/abortable.ts';
import { Hash } from '../../../src/util/Hash.ts';
import { LoopbackNetwork, LoopbackTransportPlugin } from '../../helpers/LoopbackTransport.ts';
import { makeTestContext } from '../../helpers/v2.ts';

// The loopback plugin defers delivery to a microtask, so a block crosses one hop
// per settle.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

interface Node {
  ctx: Context;
  ingested: Block[];
}

function makeNode(
  network: LoopbackNetwork,
  address: string,
  bootstrapUrls?: string[],
  maxMsgSize?: number,
): Node {
  const ctx = makeTestContext({
    transportPlugins: [new LoopbackTransportPlugin(network, address, maxMsgSize)],
    bootstrapUrls: bootstrapUrls ?? [],
  });

  ctx.get(BlockStore).ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

  const ingested: Block[] = [];
  ctx.get(BlockStore).onIngest((block) => ingested.push(block), neverAbort);

  return { ctx, ingested };
}

const publish = (node: Node): Block => {
  const drafts = node.ctx.get(DraftStore);
  drafts.build(drafts.create({}));
  return node.ingested[node.ingested.length - 1];
};

const holds = (node: Node, block: Block): boolean =>
  node.ctx.get(BlockStore).getAll().some((x) => Hash.equals(x.hash, block.hash));

Deno.test('a block published on one node reaches a node connected to it', async () => {
  const network = new LoopbackNetwork();
  const a = makeNode(network, 'loopback://a');
  // Listener first: b dials a during its own construction.
  const b = makeNode(network, 'loopback://b', ['loopback://a']);

  a.ctx.get(Gossip);
  b.ctx.get(Gossip);
  await settle();

  const block = publish(a);
  await settle();

  assert(holds(b, block));
  assertEquals(b.ingested.at(-1)!.source, AtomSource.Remote);

  await a.ctx.destruct();
  await b.ctx.destruct();
});

Deno.test('a block published before a peer connects is backfilled on connect', async () => {
  const network = new LoopbackNetwork();
  const a = makeNode(network, 'loopback://a');
  a.ctx.get(Gossip);

  const block = publish(a);

  const b = makeNode(network, 'loopback://b', ['loopback://a']);
  b.ctx.get(Gossip);
  await settle();

  assert(holds(b, block));

  await a.ctx.destruct();
  await b.ctx.destruct();
});

Deno.test('a block is relayed to a third node through the middle of a chain', async () => {
  const network = new LoopbackNetwork();
  const a = makeNode(network, 'loopback://a');
  const b = makeNode(network, 'loopback://b', ['loopback://a']);
  const c = makeNode(network, 'loopback://c', ['loopback://b']);

  a.ctx.get(Gossip);
  b.ctx.get(Gossip);
  c.ctx.get(Gossip);
  await settle();

  const block = publish(a);
  await settle();

  assert(holds(c, block));

  await a.ctx.destruct();
  await b.ctx.destruct();
  await c.ctx.destruct();
});

Deno.test('a block larger than the transport message size is reassembled by the peer', async () => {
  const network = new LoopbackNetwork();
  const a = makeNode(network, 'loopback://a', undefined, 64);
  const b = makeNode(network, 'loopback://b', ['loopback://a'], 64);

  a.ctx.get(Gossip);
  b.ctx.get(Gossip);
  await settle();

  const block = publish(a);
  assert(block.raw.byteLength > 64);
  await settle();

  assert(holds(b, block));

  await a.ctx.destruct();
  await b.ctx.destruct();
});

Deno.test('destructing a context stops the transport and closes its connections', async () => {
  const network = new LoopbackNetwork();
  const a = makeNode(network, 'loopback://a');
  const b = makeNode(network, 'loopback://b', ['loopback://a']);

  a.ctx.get(Gossip);
  b.ctx.get(Gossip);
  await settle();

  const transport = a.ctx.get(Transport);
  assertEquals(transport.getOpenConnections().size, 1);

  await a.ctx.destruct();
  assertEquals(transport.getOpenConnections().size, 0);

  await b.ctx.destruct();
});

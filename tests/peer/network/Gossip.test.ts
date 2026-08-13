import { assert, assertEquals, assertThrows } from '@std/assert';
import { Block } from '../../../src/graph/types.ts';
import { ScopedLogger } from '../../../src/logic/EventLog.ts';
import { GossipBase } from '../../../src/peer/network/GossipBase.ts';
import { MessageJoiner, MessageSplitter } from '../../../src/peer/network/MessageSplitter.ts';
import { Connection } from '../../../src/peer/network/types.ts';
import { Hash } from '../../../src/util/Hash.ts';
import { MockConnectionProvider } from '../../helpers/MockTransportPlugin.ts';

// GossipBase only reads `raw` and `hash`, so a whole Block is more than these tests need.
const fakeBlock = (byte: number): Block =>
  ({ raw: new Uint8Array([byte]), hash: Hash.digest(`block-${byte}`) }) as unknown as Block;

function fakeConnection(debugName: string): Connection {
  return {
    debugName,
    pluginName: 'fake',
    isOpen: true,
    provider: new MockConnectionProvider(),
    splitter: new MessageSplitter(Infinity),
    joiner: new MessageJoiner({ nowMs: () => 0 }),
    sentCount: 0,
    recvCount: 0,
  };
}

class TestGossip extends GossipBase {
  connections: Connection[] = [];
  blocks: Block[] = [];
  sent: { conn: string; raw: Uint8Array }[] = [];

  // Models BlockStore: ingestion fires its listeners synchronously, before returning.
  protected override ingest(raw: Uint8Array): void {
    const block = fakeBlock(raw[0]);
    this.blocks.push(block);
    this.floodBlock(block);
  }

  protected override getConnections(): Iterable<Connection> {
    return this.connections;
  }

  protected override getAllBlocks(): Block[] {
    return this.blocks;
  }

  protected override send(conn: Connection, raw: Uint8Array): void {
    this.sent.push({ conn: conn.debugName, raw });
  }

  protected override getLogger(): ScopedLogger | undefined {
    return undefined;
  }
}

interface Harness {
  gossip: TestGossip;
  a: Connection;
  b: Connection;
  c: Connection;
}

function setup(): Harness {
  const gossip = new TestGossip();
  const a = fakeConnection('a');
  const b = fakeConnection('b');
  const c = fakeConnection('c');
  gossip.connections.push(a, b, c);
  return { gossip, a, b, c };
}

Deno.test('a block received from a peer is forwarded to every other connection', () => {
  const { gossip, a } = setup();

  gossip.recvData(a, new Uint8Array([1]));

  assertEquals(gossip.sent.map((x) => x.conn), ['b', 'c']);
});

Deno.test('a block is never sent back to the connection it arrived on', () => {
  const { gossip, a } = setup();

  gossip.recvData(a, new Uint8Array([1]));

  assert(!gossip.sent.some((x) => x.conn === 'a'));
  assertEquals(gossip.fromConnections.get(gossip.blocks[0]), [a]);
});

Deno.test('a block already sent to a connection is not sent again', () => {
  const { gossip, a } = setup();

  gossip.recvData(a, new Uint8Array([1]));
  gossip.floodBlock(gossip.blocks[0]);

  assertEquals(gossip.sent.map((x) => x.conn), ['b', 'c']);
});

Deno.test('a locally ingested block is sent to every connection', () => {
  const { gossip } = setup();
  const block = fakeBlock(9);
  gossip.blocks.push(block);

  gossip.floodBlock(block);

  assertEquals(gossip.sent.map((x) => x.conn), ['a', 'b', 'c']);
});

Deno.test('a closed connection is skipped', () => {
  const { gossip, b } = setup();
  b.isOpen = false;

  gossip.floodBlock(fakeBlock(9));

  assertEquals(gossip.sent.map((x) => x.conn), ['a', 'c']);
});

Deno.test('a new connection is backfilled with every block already held', () => {
  const { gossip } = setup();
  gossip.blocks.push(fakeBlock(1), fakeBlock(2));
  const late = fakeConnection('late');
  gossip.connections.push(late);

  gossip.backfill(late);

  assertEquals(gossip.sent.map((x) => x.conn), ['late', 'late']);
  assertEquals(gossip.sent.map((x) => x.raw[0]), [1, 2]);
});

Deno.test('backfill does not return a block to the peer that sent it', () => {
  const { gossip, a } = setup();
  gossip.recvData(a, new Uint8Array([1]));
  gossip.sent.length = 0;

  gossip.backfill(a);

  assertEquals(gossip.sent, []);
});

Deno.test('backfill does not resend a block the peer already received', () => {
  const { gossip, a } = setup();
  gossip.floodBlock(fakeBlock(1));
  gossip.sent.length = 0;

  gossip.backfill(a);

  assertEquals(gossip.sent, []);
});

Deno.test('re-entrant ingestion is rejected', () => {
  const a = fakeConnection('a');
  const b = fakeConnection('b');
  const reentrant = new (class extends TestGossip {
    protected override ingest(raw: Uint8Array): void {
      super.ingest(raw);
      this.recvData(b, new Uint8Array([2]));
    }
  })();
  reentrant.connections.push(a, b);

  assertThrows(
    () => reentrant.recvData(a, new Uint8Array([1])),
    Error,
    're-entered',
  );
});

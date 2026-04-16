import { assert, assertEquals } from '@std/assert';
import { UnixSocketPlugin } from '../src/node/UnixSocketPlugin.ts';
import { TransportConnection } from '../src/node/PeerConnection.ts';

// -- Helpers --------------------------------------------------------------

/** Collect connections reported by a plugin via its NetworkDriver. */
function collectConnections(plugin: UnixSocketPlugin): TransportConnection[] {
  const conns: TransportConnection[] = [];
  plugin.start({
    onConnection(transport) {
      conns.push(transport);
    },
  });
  return conns;
}

/** Wait until a condition is met, polling every 10ms. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// -- Tests ----------------------------------------------------------------

Deno.test({
  name: 'UnixSocketPlugin: listen and connect establish a connection pair',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);

    // Both sides report a connection: server via accept, client via connect
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    assertEquals(serverConns.length, 1);
    assertEquals(clientConns.length, 1);

    server.stop();
    client.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: bidirectional message exchange',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    const serverTransport = serverConns[0];
    const clientTransport = clientConns[0];

    // Set up message collection
    const serverMessages: string[] = [];
    const clientMessages: string[] = [];
    serverTransport.onMessage((data) => serverMessages.push(data));
    clientTransport.onMessage((data) => clientMessages.push(data));

    // Client -> Server
    clientTransport.send('hello server');
    await waitFor(() => serverMessages.length === 1);
    assertEquals(serverMessages[0], 'hello server');

    // Server -> Client
    serverTransport.send('hello client');
    await waitFor(() => clientMessages.length === 1);
    assertEquals(clientMessages[0], 'hello client');

    server.stop();
    client.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: handles JSON-structured messages',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    const received: string[] = [];
    serverConns[0].onMessage((data) => received.push(data));

    // Send a structured message like PeerConnection would
    const msg = JSON.stringify({
      type: 'block',
      data: { hash: 'abc123', outputs: [1, 2, 3] },
    });
    clientConns[0].send(msg);
    await waitFor(() => received.length === 1);

    const parsed = JSON.parse(received[0]);
    assertEquals(parsed.type, 'block');
    assertEquals(parsed.data.hash, 'abc123');

    server.stop();
    client.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: multiple rapid messages maintain order',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    const received: string[] = [];
    serverConns[0].onMessage((data) => received.push(data));

    const count = 100;
    for (let i = 0; i < count; i++) {
      clientConns[0].send(`msg-${i}`);
    }

    await waitFor(() => received.length === count);

    for (let i = 0; i < count; i++) {
      assertEquals(received[i], `msg-${i}`);
    }

    server.stop();
    client.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: close fires onClose handler',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    let serverSawClose = false;
    serverConns[0].onClose(() => {
      serverSawClose = true;
    });

    // Client closes its side
    clientConns[0].close();

    await waitFor(() => serverSawClose);
    assert(serverSawClose, 'server should see close after client disconnects');

    server.stop();
    client.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: stop cleans up socket file',
  async fn() {
    const plugin = new UnixSocketPlugin();
    collectConnections(plugin);

    // Socket file should exist while listening
    const stat = await Deno.stat(plugin.socketPath).catch(() => null);
    assert(stat !== null, 'socket file should exist');

    plugin.stop();

    const statAfter = await Deno.stat(plugin.socketPath).catch(() => null);
    assertEquals(statAfter, null, 'socket file should be removed after stop');
  },
});

Deno.test({
  name: 'UnixSocketPlugin: multiple clients connect to one server',
  async fn() {
    const server = new UnixSocketPlugin();
    const client1 = new UnixSocketPlugin();
    const client2 = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    collectConnections(client1);
    collectConnections(client2);

    client1.connect(server.socketPath);
    client2.connect(server.socketPath);

    await waitFor(() => serverConns.length === 2);
    assertEquals(serverConns.length, 2);

    // Each peer should have a unique ID
    const ids = new Set(serverConns.map((c) => c.peerId));
    assertEquals(ids.size, 2, 'peer IDs should be unique');

    server.stop();
    client1.stop();
    client2.stop();
  },
});

Deno.test({
  name: 'UnixSocketPlugin: large messages are framed correctly',
  async fn() {
    const server = new UnixSocketPlugin();
    const client = new UnixSocketPlugin();

    const serverConns = collectConnections(server);
    const clientConns = collectConnections(client);

    client.connect(server.socketPath);
    await waitFor(() => serverConns.length === 1 && clientConns.length === 1);

    const received: string[] = [];
    serverConns[0].onMessage((data) => received.push(data));

    // Send a message larger than typical socket buffer sizes
    const largePayload = 'x'.repeat(256 * 1024); // 256KB
    clientConns[0].send(largePayload);

    await waitFor(() => received.length === 1, 5000);
    assertEquals(received[0].length, largePayload.length);
    assertEquals(received[0], largePayload);

    server.stop();
    client.stop();
  },
});

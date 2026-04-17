import { assert, assertEquals } from '@std/assert';
import { UnixSocketTransport } from '../src/node/UnixSocketTransport.ts';
import {
  AnonymousTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportService,
} from '../src/interfaces/transport.ts';

// -- Helpers --------------------------------------------------------------

interface OpenConn {
  provider: ConnectionProvider;
  driver: ConnectionDriver;
  received: Uint8Array[];
  closed: boolean;
}

interface DriverHarness {
  anonymousDriver: AnonymousTransportDriver;
  broadcastedAddresses: string[];
  connections: OpenConn[];
}

function makeDriverHarness(): DriverHarness {
  const broadcastedAddresses: string[] = [];
  const connections: OpenConn[] = [];

  const anonymousDriver: AnonymousTransportDriver = {
    broadcastAddress: (signal: string) => {
      broadcastedAddresses.push(signal);
    },
    createAnonymousConnection: (provider: ConnectionProvider): ConnectionDriver => {
      const open: OpenConn = {
        provider,
        driver: null as unknown as ConnectionDriver,
        received: [],
        closed: false,
      };
      open.driver = {
        recvData: (data: Uint8Array) => {
          open.received.push(data);
        },
        close: () => {
          open.closed = true;
        },
      };
      connections.push(open);
      return open.driver;
    },
  };

  return { anonymousDriver, broadcastedAddresses, connections };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Harness {
  plugin: UnixSocketTransport;
  service: TransportService;
  harness: DriverHarness;
}

function startPlugin(socketPath?: string): Harness {
  const plugin = new UnixSocketTransport(socketPath);
  const harness = makeDriverHarness();
  const service = plugin.start(harness.anonymousDriver);
  return { plugin, service, harness };
}

// -- Tests ----------------------------------------------------------------

Deno.test({
  name: 'UnixSocketTransport: emitsProtocol and acceptsProtocols',
  fn() {
    const plugin = new UnixSocketTransport();
    assertEquals(plugin.emitsProtocol, 'unix');
    assertEquals(plugin.acceptsProtocols, ['unix']);
  },
});

Deno.test({
  name: 'UnixSocketTransport: announceAddresses broadcasts the socket path',
  async fn() {
    const { plugin, service, harness } = startPlugin();
    service.announceAddresses!();
    assertEquals(harness.broadcastedAddresses, [plugin.socketPath]);
    await service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: dialAddress connects to a running listener',
  async fn() {
    const server = startPlugin();
    const client = startPlugin();

    client.service.dialAddress!(server.plugin.socketPath);

    await waitFor(() =>
      server.harness.connections.length === 1 && client.harness.connections.length === 1
    );

    assertEquals(server.harness.connections.length, 1);
    assertEquals(client.harness.connections.length, 1);

    await server.service.stop();
    await client.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: bidirectional message exchange',
  async fn() {
    const server = startPlugin();
    const client = startPlugin();

    client.service.dialAddress!(server.plugin.socketPath);
    await waitFor(() =>
      server.harness.connections.length === 1 && client.harness.connections.length === 1
    );

    const serverConn = server.harness.connections[0];
    const clientConn = client.harness.connections[0];

    // Client -> Server
    clientConn.provider.sendReliable(new TextEncoder().encode('hello server'));
    await waitFor(() => serverConn.received.length === 1);
    assertEquals(new TextDecoder().decode(serverConn.received[0]), 'hello server');

    // Server -> Client
    serverConn.provider.sendReliable(new TextEncoder().encode('hello client'));
    await waitFor(() => clientConn.received.length === 1);
    assertEquals(new TextDecoder().decode(clientConn.received[0]), 'hello client');

    await server.service.stop();
    await client.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: multiple rapid frames maintain order',
  async fn() {
    const server = startPlugin();
    const client = startPlugin();

    client.service.dialAddress!(server.plugin.socketPath);
    await waitFor(() => server.harness.connections.length === 1);

    const clientConn = client.harness.connections[0];
    const serverConn = server.harness.connections[0];

    const count = 100;
    for (let i = 0; i < count; i++) {
      clientConn.provider.sendReliable(new TextEncoder().encode(`msg-${i}`));
    }

    await waitFor(() => serverConn.received.length === count);

    for (let i = 0; i < count; i++) {
      assertEquals(new TextDecoder().decode(serverConn.received[i]), `msg-${i}`);
    }

    await server.service.stop();
    await client.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: close propagates to peer',
  async fn() {
    const server = startPlugin();
    const client = startPlugin();

    client.service.dialAddress!(server.plugin.socketPath);
    await waitFor(() =>
      server.harness.connections.length === 1 && client.harness.connections.length === 1
    );

    const clientConn = client.harness.connections[0];
    const serverConn = server.harness.connections[0];

    clientConn.provider.shutdown();

    await waitFor(() => serverConn.closed);
    assert(serverConn.closed);

    await server.service.stop();
    await client.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: stop cleans up socket file',
  async fn() {
    const { plugin, service } = startPlugin();

    const stat = await Deno.stat(plugin.socketPath).catch(() => null);
    assert(stat !== null, 'socket file should exist while running');

    await service.stop();

    const statAfter = await Deno.stat(plugin.socketPath).catch(() => null);
    assertEquals(statAfter, null, 'socket file should be removed after stop');
  },
});

Deno.test({
  name: 'UnixSocketTransport: multiple clients connect to one server',
  async fn() {
    const server = startPlugin();
    const client1 = startPlugin();
    const client2 = startPlugin();

    client1.service.dialAddress!(server.plugin.socketPath);
    client2.service.dialAddress!(server.plugin.socketPath);

    await waitFor(() => server.harness.connections.length === 2);
    assertEquals(server.harness.connections.length, 2);

    await server.service.stop();
    await client1.service.stop();
    await client2.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: large frames are transmitted correctly',
  async fn() {
    const server = startPlugin();
    const client = startPlugin();

    client.service.dialAddress!(server.plugin.socketPath);
    await waitFor(() =>
      server.harness.connections.length === 1 && client.harness.connections.length === 1
    );

    const largePayload = new TextEncoder().encode('x'.repeat(256 * 1024));
    client.harness.connections[0].provider.sendReliable(largePayload);

    await waitFor(() => server.harness.connections[0].received.length === 1, 5000);
    assertEquals(server.harness.connections[0].received[0].byteLength, largePayload.byteLength);

    await server.service.stop();
    await client.service.stop();
  },
});

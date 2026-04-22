import { assert, assertEquals } from '@std/assert';
import { UnixSocketTransport } from '../src/node/UnixSocketTransport.ts';
import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportService,
} from '../src/interfaces/transport.ts';
import { unixSocketsAvailable } from './helpers/unixSocketsAvailable.ts';

// Tests that bind unix sockets cannot run in sandboxed environments that
// deny AF_UNIX bind(). Skip the live-socket tests there; the plugin
// interface contract is covered by TransportManager.test.ts via the
// in-memory MockTransportPlugin.
const needsUnix = !unixSocketsAvailable();

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
  ignore: needsUnix,
  async fn() {
    const { plugin, service, harness } = startPlugin();
    service.announceAddresses!();
    assertEquals(harness.broadcastedAddresses, [plugin.socketPath]);
    await service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: dialAddress connects to a running listener',
  ignore: needsUnix,
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
  ignore: needsUnix,
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
  ignore: needsUnix,
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
  ignore: needsUnix,
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
  ignore: needsUnix,
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
  ignore: needsUnix,
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

// -- Authenticated mode tests --------------------------------------------

interface AuthHarness {
  driver: AuthenticatedTransportDriver;
  emittedSignals: string[];
  authConn: OpenConn | null;
}

function makeAuthHarness(): AuthHarness {
  const emittedSignals: string[] = [];
  let authConn: OpenConn | null = null;

  const driver: AuthenticatedTransportDriver = {
    sendSignal: (s) => {
      emittedSignals.push(s);
    },
    createAuthenticatedConnection: (provider: ConnectionProvider): ConnectionDriver => {
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
      authConn = open;
      return open.driver;
    },
  };

  // authConn is mutated via closure; expose it via a getter property
  return {
    driver,
    emittedSignals,
    get authConn() {
      return authConn;
    },
  } as AuthHarness;
}

Deno.test({
  name: 'UnixSocketTransport: authenticated handshake end-to-end',
  ignore: needsUnix,
  async fn() {
    const initiator = startPlugin();
    const receiver = startPlugin();

    const initAuth = makeAuthHarness();
    const recvAuth = makeAuthHarness();

    // Initiator side: start an authenticated session. Do not pass an
    // inbound signal, so the microtask elects 'init' role and emits one.
    const initSession = initiator.service.initializeAuthenticatedTransport!(initAuth.driver);

    // Yield to let the microtask fire.
    await new Promise((r) => setTimeout(r, 0));

    assertEquals(initAuth.emittedSignals.length, 1);
    const signal = initAuth.emittedSignals[0];
    assert(signal.startsWith('unix:/'), `expected unix: signal, got ${signal}`);

    // Receiver side: the TransportManager would call
    // initializeAuthenticatedTransport followed synchronously by
    // recvSignal(signal). Emulate that ordering here.
    const recvSession = receiver.service.initializeAuthenticatedTransport!(recvAuth.driver);
    recvSession.recvSignal(signal);

    // Wait for both sides to register authenticated connections.
    await waitFor(() => initAuth.authConn !== null && recvAuth.authConn !== null);

    // Bidirectional data exchange over the authenticated channel.
    recvAuth.authConn!.provider.sendReliable(new TextEncoder().encode('hi from receiver'));
    await waitFor(() => initAuth.authConn!.received.length === 1);
    assertEquals(
      new TextDecoder().decode(initAuth.authConn!.received[0]),
      'hi from receiver',
    );

    initAuth.authConn!.provider.sendReliable(new TextEncoder().encode('hi from initiator'));
    await waitFor(() => recvAuth.authConn!.received.length === 1);
    assertEquals(
      new TextDecoder().decode(recvAuth.authConn!.received[0]),
      'hi from initiator',
    );

    // No anonymous connections should have been created.
    assertEquals(initiator.harness.connections.length, 0);
    assertEquals(receiver.harness.connections.length, 0);

    initSession.close();
    recvSession.close();
    await initiator.service.stop();
    await receiver.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: receiver role does not emit a signal',
  ignore: needsUnix,
  async fn() {
    const plugin = startPlugin();
    const auth = makeAuthHarness();

    const session = plugin.service.initializeAuthenticatedTransport!(auth.driver);
    // Fire recvSignal synchronously before the microtask runs. This
    // should preempt the init-role send-path.
    session.recvSignal('unix:/tmp/nonexistent-scaffold-auth.sock');

    await new Promise((r) => setTimeout(r, 10));
    assertEquals(auth.emittedSignals.length, 0);

    session.close();
    await plugin.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: authenticated session close cleans up listener',
  ignore: needsUnix,
  async fn() {
    const plugin = startPlugin();
    const auth = makeAuthHarness();

    const session = plugin.service.initializeAuthenticatedTransport!(auth.driver);
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(auth.emittedSignals.length, 1);

    const authPath = auth.emittedSignals[0].slice('unix:'.length);
    const statBefore = await Deno.stat(authPath).catch(() => null);
    assert(statBefore !== null, 'auth socket should exist after init');

    session.close();

    // Allow the async close/unlink to complete.
    await new Promise((r) => setTimeout(r, 20));
    const statAfter = await Deno.stat(authPath).catch(() => null);
    assertEquals(statAfter, null, 'auth socket should be removed after session close');

    await plugin.service.stop();
  },
});

Deno.test({
  name: 'UnixSocketTransport: large frames are transmitted correctly',
  ignore: needsUnix,
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

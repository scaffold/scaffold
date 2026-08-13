import { assert, assertEquals, assertStrictEquals, assertThrows } from '@std/assert';
import { TimeProvider } from '../../../src/Config.ts';
import { TransportPlugin } from '../../../src/interfaces/transport.ts';
import { EventLogProvider } from '../../../plugins/EventLogProvider.ts';
import { ScopedLogger } from '../../../src/logic/Logger.ts';
import { MessageSplitter } from '../../../src/peer/network/MessageSplitter.ts';
import { TransportBase } from '../../../src/peer/network/TransportBase.ts';
import { Connection } from '../../../src/peer/network/types.ts';
import { MockConnectionProvider, MockTransportPlugin } from '../../helpers/MockTransportPlugin.ts';

const timeProvider: TimeProvider = {
  nowMs: () => 0,
  setImmediate: () => {},
  setTimeout: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => {},
  setInterval: () => 0 as unknown as ReturnType<typeof setTimeout>,
  clearInterval: () => {},
};

class RecordingTransport extends TransportBase {
  ready: Connection[] = [];
  received: { conn: Connection; data: Uint8Array }[] = [];
  closed: Connection[] = [];
  announced: string[] = [];
  dataError?: Error;

  constructor(plugins: TransportPlugin[], bootstrapUrls: URL[], private log?: ScopedLogger) {
    super();
    for (const plugin of plugins) {
      this.startTransport(plugin, (url) => this.announced.push(url.href));
    }
    for (const url of bootstrapUrls) {
      this.connect(url);
    }
  }

  protected override onConnectionReady(conn: Connection): void {
    this.ready.push(conn);
  }

  protected override onConnectionData(conn: Connection, data: Uint8Array): void {
    this.received.push({ conn, data });
    if (this.dataError !== undefined) throw this.dataError;
  }

  protected override onConnectionClosed(conn: Connection): void {
    this.closed.push(conn);
  }

  protected override getLogger(): ScopedLogger | undefined {
    return this.log;
  }

  protected override getTimeProvider(): TimeProvider {
    return timeProvider;
  }
}

interface Harness {
  plugin: MockTransportPlugin;
  transport: RecordingTransport;
  eventLog: EventLogProvider;
}

function setup(
  options: { plugins?: TransportPlugin[]; bootstrapUrls?: string[] } = {},
): Harness {
  const plugin = new MockTransportPlugin();
  const eventLog = new EventLogProvider();
  const transport = new RecordingTransport(
    options.plugins ?? [plugin],
    (options.bootstrapUrls ?? []).map((url) => new URL(url)),
    ScopedLogger.create(eventLog, () => Date.now(), 'transport'),
  );
  return { plugin, transport, eventLog };
}

const warned = (eventLog: EventLogProvider, event: string): boolean =>
  eventLog.query({ event, level: 'warn' }).length > 0;

Deno.test('every plugin is started', () => {
  const first = new MockTransportPlugin();
  const second = new MockTransportPlugin();
  setup({ plugins: [first, second] });

  assertEquals([first.startedCount, second.startedCount], [1, 1]);
});

Deno.test('an announced address is reported to the announce callback', () => {
  const { plugin, transport } = setup();
  plugin.anonymousDriver!.announceAddresses([new URL('mock://listening')]);

  assertEquals(transport.announced, ['mock://listening']);
});

Deno.test('re-announcing the same address set does not report it again', () => {
  const { plugin, transport } = setup();
  plugin.anonymousDriver!.announceAddresses([new URL('mock://listening')]);
  plugin.anonymousDriver!.announceAddresses([new URL('mock://listening')]);

  assertEquals(transport.announced, ['mock://listening']);
});

Deno.test('a bootstrap url is dialed by the plugin whose acceptsUrl claims it', () => {
  const mock = new MockTransportPlugin();
  const other = new MockTransportPlugin({ acceptsScheme: 'other' });
  setup({ plugins: [mock, other], bootstrapUrls: ['other://host:1234/'] });

  assertEquals(mock.dialCalls, []);
  assertEquals(other.dialCalls.length, 1);
});

Deno.test('a bootstrap url is dialed with its scheme and path intact', () => {
  const { plugin } = setup({ bootstrapUrls: ['mock://host:1234/some/path'] });

  assertEquals(plugin.dialCalls, ['mock://host:1234/some/path']);
});

// The two namespaces are separate: a signaling protocol id is not a URL scheme.
Deno.test('a signaling protocol id does not route a bootstrap url', () => {
  const plugin = new MockTransportPlugin({ acceptsProtocols: ['nosuch'], acceptsScheme: 'mock' });

  assertThrows(
    () => setup({ plugins: [plugin], bootstrapUrls: ['nosuch://host/'] }),
    Error,
    'No plugin accepts url nosuch://host/',
  );
  assertEquals(plugin.dialCalls, []);
});

Deno.test('a bootstrap url no plugin accepts is rejected', () => {
  assertThrows(
    () => setup({ bootstrapUrls: ['nosuch://host/'] }),
    Error,
    'No plugin accepts url nosuch://host/',
  );
});

Deno.test('an inbound connection is reported ready', () => {
  const { plugin, transport } = setup();
  plugin.injectAnonymousConnection();

  assertEquals(transport.ready.length, 1);
  assert(transport.ready[0].isOpen);
  assertEquals([...transport.getOpenConnections()], transport.ready);
});

Deno.test('data received on a connection is delivered to the handler', () => {
  const { plugin, transport } = setup();
  const { driver } = plugin.injectAnonymousConnection();

  const message = new Uint8Array([1, 2, 3]);
  driver.recvData(message);

  assertEquals(transport.received.length, 1);
  assertStrictEquals(transport.received[0].conn, transport.ready[0]);
  assertEquals(transport.received[0].data, message);
});

Deno.test('a chunked message is delivered once, reassembled', () => {
  const { plugin, transport } = setup();
  const { driver } = plugin.injectAnonymousConnection();

  const message = new Uint8Array(5000).map((_, i) => i & 0xff);
  const chunks = [...new MessageSplitter(1024).send(message)];
  assert(chunks.length > 1);
  for (const chunk of chunks) driver.recvData(chunk);

  assertEquals(transport.received.length, 1);
  assertEquals(transport.received[0].data, message);
});

Deno.test('a malformed chunk closes the connection and is logged', () => {
  const { plugin, transport, eventLog } = setup();
  const { driver } = plugin.injectAnonymousConnection();

  const chunk = [...new MessageSplitter(1024).send(new Uint8Array(64))][0];
  const malformed = new Uint8Array(32);
  new DataView(malformed.buffer).setUint32(0, 57, true);
  new DataView(malformed.buffer).setUint32(8, 2, true);
  new DataView(malformed.buffer).setUint32(12, 5, true);
  assertEquals(chunk.byteLength, 64);

  driver.recvData(malformed);

  assertEquals(transport.received, []);
  assertEquals(transport.closed, transport.ready);
  assert(warned(eventLog, 'malformedChunk'));
});

Deno.test('a throw from the data handler is logged but keeps the connection open', () => {
  const { plugin, transport, eventLog } = setup();
  const { driver } = plugin.injectAnonymousConnection();
  transport.dataError = new Error('ingestion blew up');

  driver.recvData(new Uint8Array([1, 2, 3]));

  assertEquals(transport.closed, []);
  assert(transport.ready[0].isOpen);
  assert(warned(eventLog, 'recvHandlerFailed'));
});

Deno.test('a reliable send reaches the provider', () => {
  const { plugin, transport } = setup();
  const { provider } = plugin.injectAnonymousConnection();

  const message = new Uint8Array([4, 5, 6]);
  transport.sendReliable(transport.ready[0], message);

  assertEquals(provider.sent, [message]);
  assertEquals(transport.ready[0].sentCount, 1);
});

Deno.test('a send is split when the provider declares a maximum message size', () => {
  const { plugin, transport } = setup();
  const provider = new MockConnectionProvider();
  provider.maxMsgSize = 1024;
  plugin.anonymousDriver!.createAnonymousConnection(provider);

  transport.sendReliable(transport.ready[0], new Uint8Array(5000));

  assert(provider.sent.length > 1);
  for (const chunk of provider.sent) assert(chunk.byteLength <= 1024);
});

Deno.test('sending after close is a no-op', () => {
  const { plugin, transport, eventLog } = setup();
  const { provider } = plugin.injectAnonymousConnection();
  const conn = transport.ready[0];

  transport.close(conn);
  transport.sendReliable(conn, new Uint8Array([1]));

  assertEquals(provider.sent, []);
  assertEquals(eventLog.query({ event: 'sendAfterClose' }).length, 1);
});

Deno.test('a send that throws closes the connection', () => {
  const { plugin, transport, eventLog } = setup();
  const { provider } = plugin.injectAnonymousConnection();
  provider.sendReliable = () => {
    throw new Error('channel is not open');
  };

  transport.sendReliable(transport.ready[0], new Uint8Array([1]));

  assertEquals(transport.closed, transport.ready);
  assert(warned(eventLog, 'sendFailed'));
});

Deno.test('a local close shuts the provider down and reports the closure once', () => {
  const { plugin, transport } = setup();
  const { provider } = plugin.injectAnonymousConnection();
  const conn = transport.ready[0];

  transport.close(conn);
  transport.close(conn);

  assert(provider.shutdownCalled);
  assertEquals(transport.closed, [conn]);
  assertEquals([...transport.getOpenConnections()], []);
});

Deno.test('a remote close does not shut the provider down', () => {
  const { plugin, transport } = setup();
  const { provider, driver } = plugin.injectAnonymousConnection();

  driver.close();

  assertEquals(provider.shutdownCalled, false);
  assertEquals(transport.closed, transport.ready);
});

Deno.test('data arriving after close is dropped', () => {
  const { plugin, transport } = setup();
  const { driver } = plugin.injectAnonymousConnection();

  transport.close(transport.ready[0]);
  driver.recvData(new Uint8Array([1, 2, 3]));

  assertEquals(transport.received, []);
});

Deno.test('stopping closes every connection and stops every plugin', async () => {
  const { plugin, transport } = setup();
  plugin.injectAnonymousConnection();
  plugin.injectAnonymousConnection();

  await transport.stop();

  assertEquals(transport.closed.length, 2);
  assertEquals([...transport.getOpenConnections()], []);
  assertEquals(plugin.stoppedCount, 1);
});

Deno.test('a plugin that fails to stop is logged rather than failing the shutdown', async () => {
  const failing: TransportPlugin = {
    name: 'MockTransportPlugin',
    emitsProtocol: 'failing',
    acceptsProtocols: ['failing'],
    start: () => ({ stop: () => Promise.reject(new Error('stop blew up')) }),
  };
  const working = new MockTransportPlugin();
  const eventLog = new EventLogProvider();
  const transport = new RecordingTransport(
    [failing, working],
    [],
    ScopedLogger.create(eventLog, () => Date.now(), 'transport'),
  );

  await transport.stop();

  assertEquals(working.stoppedCount, 1);
  assert(warned(eventLog, 'pluginStopFailed'));
});

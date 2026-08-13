import { assertEquals } from '@std/assert';
import { LogEvent, LoggingProvider, LogLevel } from '../../src/interfaces/LoggingProvider.ts';
import { ScopedLogger } from '../../src/logic/Logger.ts';

class Capture implements LoggingProvider {
  events: LogEvent[] = [];

  constructor(private levels: (system: string) => LogLevel | undefined) {}

  level(system: string): LogLevel | undefined {
    return this.levels(system);
  }

  handle(event: LogEvent): void {
    this.events.push(event);
  }
}

const at = () => 1000;

Deno.test('ScopedLogger.create: yields undefined when there is no provider', () => {
  assertEquals(ScopedLogger.create(undefined, at, 'sys'), undefined);
});

Deno.test('ScopedLogger.create: yields undefined for a subsystem the provider disables', () => {
  const provider = new Capture((system) => system === 'on' ? 'debug' : undefined);
  assertEquals(ScopedLogger.create(provider, at, 'off'), undefined);
  assertEquals(ScopedLogger.create(provider, at, 'on') === undefined, false);
});

Deno.test('ScopedLogger: emits an event carrying system, level and timestamp', () => {
  const provider = new Capture(() => 'debug');
  ScopedLogger.create(provider, at, 'sys')?.info('started', { port: 1 });

  assertEquals(provider.events.length, 1);
  assertEquals(provider.events[0], {
    system: 'sys',
    event: 'started',
    level: 'info',
    timestamp: 1000,
    data: { port: 1 },
  });
});

Deno.test('ScopedLogger: drops events below the subsystem minimum level', () => {
  const provider = new Capture(() => 'warn');
  const log = ScopedLogger.create(provider, at, 'sys');

  log?.debug('d');
  log?.info('i');
  log?.warn('w');
  log?.error('e');

  assertEquals(provider.events.map((x) => x.event), ['w', 'e']);
});

Deno.test('ScopedLogger: data defaults to an empty object', () => {
  const provider = new Capture(() => 'debug');
  ScopedLogger.create(provider, at, 'sys')?.warn('bare');
  assertEquals(provider.events[0].data, {});
});

Deno.test('ScopedLogger.enabled: reports whether a level would be emitted', () => {
  const log = ScopedLogger.create(new Capture(() => 'warn'), at, 'sys');
  assertEquals(log?.enabled('debug'), false);
  assertEquals(log?.enabled('warn'), true);
  assertEquals(log?.enabled('error'), true);
});

Deno.test('ScopedLogger.child: appends a dotted segment to the system name', () => {
  const provider = new Capture(() => 'debug');
  ScopedLogger.create(provider, at, 'transport')?.child('joiner')?.info('ev');
  assertEquals(provider.events[0].system, 'transport.joiner');
});

Deno.test('ScopedLogger.child: merges bound data into every event it emits', () => {
  const provider = new Capture(() => 'debug');
  const child = ScopedLogger.create(provider, at, 'transport')?.child('conn', { peer: 'a' });

  child?.info('sent', { bytes: 4 });
  child?.info('closed');

  assertEquals(provider.events[0].data, { peer: 'a', bytes: 4 });
  assertEquals(provider.events[1].data, { peer: 'a' });
});

Deno.test('ScopedLogger.child: event data wins over bound data on conflict', () => {
  const provider = new Capture(() => 'debug');
  ScopedLogger.create(provider, at, 'sys')?.child('c', { k: 'bound' })?.info('ev', { k: 'event' });
  assertEquals(provider.events[0].data, { k: 'event' });
});

Deno.test('ScopedLogger.child: yields undefined when the child system is disabled', () => {
  const provider = new Capture((system) => system === 'sys' ? 'debug' : undefined);
  assertEquals(ScopedLogger.create(provider, at, 'sys')?.child('quiet'), undefined);
});

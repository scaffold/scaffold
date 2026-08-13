import { assertEquals } from '@std/assert';
import { EventLogProvider, LogEntry } from '../../plugins/EventLogProvider.ts';
import { LogEvent, LogLevel } from '../../src/interfaces/LoggingProvider.ts';
import { neverAbort } from '../../src/util/abortable.ts';

const event = (
  ev: string,
  opts: { system?: string; level?: LogLevel; data?: Record<string, unknown> } = {},
): LogEvent => ({
  system: opts.system ?? 'sys',
  event: ev,
  level: opts.level ?? 'info',
  timestamp: 0,
  data: opts.data ?? {},
});

Deno.test('EventLogProvider: defaults to capturing every subsystem at debug', () => {
  assertEquals(new EventLogProvider().level('anything'), 'debug');
});

Deno.test('EventLogProvider: takes its level policy from a spec', () => {
  const log = new EventLogProvider({ level: 'warn,gossip=off' });
  assertEquals(log.level('transport'), 'warn');
  assertEquals(log.level('gossip'), undefined);
});

Deno.test('EventLogProvider: assigns monotonic sequence numbers', () => {
  const log = new EventLogProvider();
  log.handle(event('a'));
  log.handle(event('b'));
  assertEquals(log.last().map((x) => x.seq), [0, 1]);
  assertEquals(log.getNextSeq(), 2);
});

Deno.test('EventLogProvider.onAppend: fires for every handled event', () => {
  const log = new EventLogProvider();
  const seen: LogEntry[] = [];
  log.onAppend((e) => seen.push(e), neverAbort);

  log.handle(event('e1', { data: { a: 1 } }));
  log.handle(event('e2', { level: 'warn' }));

  assertEquals(seen.map((x) => x.event), ['e1', 'e2']);
  assertEquals(seen[0].data.a, 1);
  assertEquals(seen[1].level, 'warn');
});

Deno.test('EventLogProvider.onAppend: aborting the signal stops delivery', () => {
  const log = new EventLogProvider();
  const seen: LogEntry[] = [];
  const controller = new AbortController();
  log.onAppend((e) => seen.push(e), controller.signal);

  log.handle(event('before'));
  controller.abort();
  log.handle(event('after'));

  assertEquals(seen.map((x) => x.event), ['before']);
});

Deno.test('EventLogProvider.onAppend: every subscriber receives every event', () => {
  const log = new EventLogProvider();
  const a: LogEntry[] = [];
  const b: LogEntry[] = [];
  log.onAppend((e) => a.push(e), neverAbort);
  log.onAppend((e) => b.push(e), neverAbort);

  log.handle(event('ev'));

  assertEquals(a.length, 1);
  assertEquals(b.length, 1);
});

Deno.test('EventLogProvider.onAppend: a throwing subscriber does not stop the rest', () => {
  const log = new EventLogProvider();
  const seen: LogEntry[] = [];
  log.onAppend(() => {
    throw new Error('bad subscriber');
  }, neverAbort);
  log.onAppend((e) => seen.push(e), neverAbort);

  log.handle(event('ev'));

  assertEquals(seen.length, 1);
  assertEquals(log.getSize(), 1);
});

Deno.test('EventLogProvider.onAppend: subscribers see the entry already buffered', () => {
  const log = new EventLogProvider();
  let sizeAtCallback = -1;
  log.onAppend(() => sizeAtCallback = log.getSize(), neverAbort);

  log.handle(event('ev'));

  assertEquals(sizeAtCallback, 1);
});

Deno.test('EventLogProvider.query: filters by system, event and level', () => {
  const log = new EventLogProvider();
  log.handle(event('a', { system: 'x' }));
  log.handle(event('b', { system: 'y', level: 'warn' }));
  log.handle(event('a', { system: 'y' }));

  assertEquals(log.query({ system: 'y' }).map((e) => e.event), ['b', 'a']);
  assertEquals(log.query({ event: 'a' }).map((e) => e.system), ['x', 'y']);
  assertEquals(log.query({ level: 'warn' }).map((e) => e.event), ['b']);
});

Deno.test('EventLogProvider.query: returns entries in chronological order', () => {
  const log = new EventLogProvider();
  for (const name of ['a', 'b', 'c']) log.handle(event(name));
  assertEquals(log.query().map((e) => e.event), ['a', 'b', 'c']);
});

Deno.test('EventLogProvider.query: limit keeps the most recent entries', () => {
  const log = new EventLogProvider();
  for (const name of ['a', 'b', 'c']) log.handle(event(name));
  assertEquals(log.query({ limit: 2 }).map((e) => e.event), ['b', 'c']);
});

Deno.test('EventLogProvider.forBlock: matches a hash prefix anywhere in the data', () => {
  const log = new EventLogProvider();
  log.handle(event('built', { data: { hash: 'abcdef0123456789' } }));
  log.handle(event('other', { data: { hash: 'ffffffffffffffff' } }));

  assertEquals(log.forBlock('abcdef').map((e) => e.event), ['built']);
});

Deno.test('EventLogProvider: trims the buffer once it exceeds maxSize', () => {
  const log = new EventLogProvider({ maxSize: 4 });
  for (let i = 0; i < 6; i++) log.handle(event(`e${i}`));

  // Trimming at 5 keeps the recent 3, so the 6th lands in a buffer of 4
  assertEquals(log.getSize(), 4);
  assertEquals(log.last(4).map((e) => e.event), ['e2', 'e3', 'e4', 'e5']);
});

Deno.test('EventLogProvider.clear: empties the buffer but keeps the sequence', () => {
  const log = new EventLogProvider();
  log.handle(event('a'));
  log.clear();

  assertEquals(log.getSize(), 0);
  assertEquals(log.getNextSeq(), 1);
});

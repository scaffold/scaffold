import { assertEquals } from '@std/assert';
import { EventLog, type LogEntry } from '../../src/logic/EventLog.ts';

Deno.test('EventLog.onAppend: fires for every appended entry', () => {
  const log = new EventLog();
  const seen: LogEntry[] = [];
  log.onAppend((e) => seen.push(e));

  log.append('sys', 'e1', { a: 1 });
  log.append('sys', 'e2', { b: 2 }, 'warn');

  assertEquals(seen.length, 2);
  assertEquals(seen[0].event, 'e1');
  assertEquals(seen[0].data.a, 1);
  assertEquals(seen[0].level, 'info');
  assertEquals(seen[1].event, 'e2');
  assertEquals(seen[1].level, 'warn');
});

Deno.test('EventLog.onAppend: unsubscribe stops delivery', () => {
  const log = new EventLog();
  const seen: LogEntry[] = [];
  const unsubscribe = log.onAppend((e) => seen.push(e));

  log.append('sys', 'before', {});
  unsubscribe();
  log.append('sys', 'after', {});

  assertEquals(seen.length, 1);
  assertEquals(seen[0].event, 'before');
});

Deno.test('EventLog.onAppend: multiple subscribers each receive every entry', () => {
  const log = new EventLog();
  const a: LogEntry[] = [];
  const b: LogEntry[] = [];
  log.onAppend((e) => a.push(e));
  log.onAppend((e) => b.push(e));

  log.append('sys', 'ev', {});

  assertEquals(a.length, 1);
  assertEquals(b.length, 1);
});

Deno.test('EventLog.onAppend: subscriber throws do not affect other subscribers or append', () => {
  const log = new EventLog();
  const seen: LogEntry[] = [];
  log.onAppend(() => {
    throw new Error('bad subscriber');
  });
  log.onAppend((e) => seen.push(e));

  const seq = log.append('sys', 'ev', {});

  assertEquals(seq, 0);
  assertEquals(seen.length, 1);
  assertEquals(log.size, 1);
});

Deno.test('EventLog.onAppend: subscribers see the entry already in the buffer', () => {
  const log = new EventLog();
  let bufferSizeAtCallback = -1;
  log.onAppend(() => {
    bufferSizeAtCallback = log.size;
  });

  log.append('sys', 'ev', {});

  assertEquals(bufferSizeAtCallback, 1);
});

Deno.test('EventLog.onAppend: delivery order matches append order', () => {
  const log = new EventLog();
  const events: string[] = [];
  log.onAppend((e) => events.push(e.event));

  log.append('sys', 'a', {});
  log.append('sys', 'b', {});
  log.append('sys', 'c', {});

  assertEquals(events, ['a', 'b', 'c']);
});

Deno.test('EventLog: append works without subscribers', () => {
  const log = new EventLog();
  log.append('sys', 'ev', {});
  assertEquals(log.size, 1);
});

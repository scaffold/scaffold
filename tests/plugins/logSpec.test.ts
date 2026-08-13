import { assertEquals, assertThrows } from '@std/assert';
import { parseLogSpec } from '../../plugins/logSpec.ts';

Deno.test('parseLogSpec: a bare level applies to every subsystem', () => {
  const level = parseLogSpec('warn');
  assertEquals(level('gossip'), 'warn');
  assertEquals(level('anything.at.all'), 'warn');
});

Deno.test('parseLogSpec: an override beats the default for its subsystem', () => {
  const level = parseLogSpec('warn,gossip=debug');
  assertEquals(level('gossip'), 'debug');
  assertEquals(level('transport'), 'warn');
});

Deno.test('parseLogSpec: an override covers dotted children of its subsystem', () => {
  const level = parseLogSpec('warn,transport=debug');
  assertEquals(level('transport.joiner'), 'debug');
});

Deno.test('parseLogSpec: the longest matching prefix wins', () => {
  const level = parseLogSpec('error,transport=warn,transport.joiner=debug');
  assertEquals(level('transport'), 'warn');
  assertEquals(level('transport.joiner'), 'debug');
  assertEquals(level('transport.other'), 'warn');
  assertEquals(level('gossip'), 'error');
});

Deno.test('parseLogSpec: a prefix only matches on a segment boundary', () => {
  const level = parseLogSpec('error,transport=debug');
  assertEquals(level('transportation'), 'error');
});

Deno.test('parseLogSpec: off disables a subsystem', () => {
  const level = parseLogSpec('debug,wasm=off');
  assertEquals(level('wasm'), undefined);
  assertEquals(level('gossip'), 'debug');
});

Deno.test('parseLogSpec: an empty spec disables everything', () => {
  assertEquals(parseLogSpec('')('gossip'), undefined);
});

Deno.test('parseLogSpec: only the named subsystems log when no default is given', () => {
  const level = parseLogSpec('gossip=debug');
  assertEquals(level('gossip'), 'debug');
  assertEquals(level('transport'), undefined);
});

Deno.test('parseLogSpec: surrounding whitespace is ignored', () => {
  const level = parseLogSpec(' warn , gossip = debug ');
  assertEquals(level('gossip'), 'debug');
  assertEquals(level('transport'), 'warn');
});

Deno.test('parseLogSpec: an unknown level name throws', () => {
  assertThrows(() => parseLogSpec('chatty'), Error, "Unknown log level 'chatty'");
});

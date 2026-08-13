import { LogLevel } from '../src/interfaces/LoggingProvider.ts';
import { error } from '../src/util/functional.ts';

export type LevelFn = (system: string) => LogLevel | undefined;

const LEVELS: string[] = ['debug', 'info', 'warn', 'error'];

function parseLevel(name: string): LogLevel | undefined {
  if (name === 'off' || name === 'none') return undefined;
  if (!LEVELS.includes(name)) {
    error(`Unknown log level '${name}'; expected one of ${LEVELS.join(', ')}, off`);
  }
  return name as LogLevel;
}

/**
 * Parse a verbosity spec into a level policy, so a sink never implements one.
 *
 * `'warn'` sets every subsystem, `'warn,gossip=debug,wasm=off'` adds overrides.
 * Overrides match dotted subsystems by prefix -- `gossip=debug` covers
 * `gossip.joiner` -- and the longest matching prefix wins.
 */
export function parseLogSpec(spec: string): LevelFn {
  let fallback: LogLevel | undefined;
  const overrides = new Map<string, LogLevel | undefined>();

  for (const part of spec.split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    const eq = entry.indexOf('=');
    if (eq === -1) {
      fallback = parseLevel(entry);
    } else {
      overrides.set(entry.slice(0, eq).trim(), parseLevel(entry.slice(eq + 1).trim()));
    }
  }

  if (overrides.size === 0) return () => fallback;

  return (system: string) => {
    let best: string | undefined;
    for (const key of overrides.keys()) {
      if (system !== key && !system.startsWith(key + '.')) continue;
      if (best === undefined || key.length > best.length) best = key;
    }
    return best === undefined ? fallback : overrides.get(best);
  };
}

/** Accepts either a spec string or a ready-made policy. */
export function toLevelFn(level: string | LevelFn): LevelFn {
  return typeof level === 'string' ? parseLogSpec(level) : level;
}

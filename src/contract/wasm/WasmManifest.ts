// A WASM contract is identified by the hash of its manifest blob: fetching
// `{contract: BLOB_CONTRACT, params: contractHash}` yields this document,
// which names the module blob and maps entry points to its exports. The
// version field is the only extension gate -- layers, memory caps, and WASI
// arrive as version bumps, never as tolerated extra keys.

import { error } from '../../util/functional.ts';
import { Hash, HASH_REGEX } from '../../util/Hash.ts';

export const WASM_ENTRY_POINTS = [
  'run',
  'walk_params',
  'walk_data',
  'build_params',
  'build_data',
] as const;
export type WasmEntryPoint = typeof WASM_ENTRY_POINTS[number];

export interface WasmManifest {
  version: 1;
  module: Hash;
  entries: Partial<Record<WasmEntryPoint, string>> & { run: string };
}

export function parseManifest(bytes: Uint8Array): WasmManifest {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    error(`manifest is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    error('manifest must be a JSON object');
  }
  const obj = json as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (key !== 'version' && key !== 'module' && key !== 'entries') {
      error(`manifest has unknown key "${key}"`);
    }
  }
  if (obj.version !== 1) {
    error(`manifest version must be 1, got ${JSON.stringify(obj.version)}`);
  }
  if (typeof obj.module !== 'string' || !HASH_REGEX.test(obj.module)) {
    error('manifest "module" must be a 64-char hex hash');
  }
  if (obj.entries === null || typeof obj.entries !== 'object' || Array.isArray(obj.entries)) {
    error('manifest "entries" must be an object');
  }
  const entries = obj.entries as Record<string, unknown>;
  for (const [key, value] of Object.entries(entries)) {
    if (!(WASM_ENTRY_POINTS as readonly string[]).includes(key)) {
      error(`manifest has unknown entry point "${key}"`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      error(`manifest entry "${key}" must name an export`);
    }
  }
  if (entries.run === undefined) {
    error('manifest must define a "run" entry');
  }

  return {
    version: 1,
    module: Hash.fromHex(obj.module),
    entries: entries as WasmManifest['entries'],
  };
}

export function encodeManifest(manifest: WasmManifest): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    version: manifest.version,
    module: manifest.module.toHex(),
    entries: manifest.entries,
  }));
}

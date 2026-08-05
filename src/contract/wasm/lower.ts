// How host values cross the guest boundary, written down once: bytes/str
// params arrive as (ptr, len) pairs, bytes/str results leave as a packed i64
// allocated through the guest's `alloc`, scalars pass through. Transports
// differ only in how the lowered call is scheduled (sync / suspending /
// worker round-trip), not in this encoding.

import { assert, error } from '../../util/functional.ts';
import { HostImport, HostImports, ValueKind } from './WasmTransport.ts';

export interface GuestView {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
}

export function resolveGuest(exports: WebAssembly.Exports): GuestView {
  const { memory, alloc } = exports;
  assert(memory instanceof WebAssembly.Memory, 'guest must export "memory"');
  assert(typeof alloc === 'function', 'guest must export "alloc"');
  return { memory, alloc: alloc as GuestView['alloc'] };
}

// Guest offset 0 is reserved: `alloc` must never return it, and packed 0 is
// the "absent" sentinel. Empty-but-present bytes are pack(alloc(0), 0), which
// is nonzero.
export const packPtrLen = (ptr: number, len: number): bigint => {
  assert(Number.isInteger(ptr) && ptr > 0 && ptr <= 0xffffffff, `invalid guest pointer ${ptr}`);
  assert(Number.isInteger(len) && len >= 0 && len <= 0xffffffff, `invalid guest length ${len}`);
  return (BigInt(ptr) << 32n) | BigInt(len);
};

export const unpackPtrLen = (packed: bigint): { ptr: number; len: number } => {
  assert(packed > 0n && packed <= 0xffffffffffffffffn, `invalid packed pointer ${packed}`);
  return { ptr: Number(packed >> 32n), len: Number(packed & 0xffffffffn) };
};

export function readBytes(guest: GuestView, ptr: number, len: number): Uint8Array {
  // Always copy: the view dies when guest memory grows.
  return new Uint8Array(guest.memory.buffer, ptr, len).slice();
}

export function writeBytes(guest: GuestView, bytes: Uint8Array): { ptr: number; len: number } {
  const ptr = guest.alloc(bytes.byteLength);
  assert(Number.isInteger(ptr) && ptr > 0, `guest alloc returned ${ptr}`);
  new Uint8Array(guest.memory.buffer, ptr, bytes.byteLength).set(bytes);
  return { ptr, len: bytes.byteLength };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function decodeArgs(guest: GuestView, kinds: ValueKind[], raw: unknown[]): unknown[] {
  const args: unknown[] = [];
  let i = 0;
  for (const kind of kinds) {
    switch (kind) {
      case 'bytes':
        args.push(readBytes(guest, raw[i++] as number, raw[i++] as number));
        break;
      case 'str':
        args.push(decoder.decode(readBytes(guest, raw[i++] as number, raw[i++] as number)));
        break;
      case 'i32':
      case 'i64':
      case 'f64':
        args.push(raw[i++]);
        break;
      case 'void':
        error('void is not a parameter kind');
    }
  }
  assert(i === raw.length, `expected ${i} core args, got ${raw.length}`);
  return args;
}

export function encodeResult(
  guest: GuestView,
  kind: ValueKind,
  value: unknown,
): number | bigint | undefined {
  switch (kind) {
    case 'void':
      return undefined;
    case 'i32':
    case 'f64':
      return value as number;
    case 'i64':
      return value as bigint;
    case 'bytes': {
      const { ptr, len } = writeBytes(guest, value as Uint8Array);
      return packPtrLen(ptr, len);
    }
    case 'str': {
      const { ptr, len } = writeBytes(guest, encoder.encode(value as string));
      return packPtrLen(ptr, len);
    }
  }
}

/**
 * Resolve the module's declared function imports against the provided tables.
 * A declared import missing from `tables` traps at call time rather than
 * failing instantiation: one module carries every entry point's imports, but
 * only the active entry's tables are live during an invoke.
 */
export function buildImportObject(
  module: WebAssembly.Module,
  tables: Record<string, HostImports>,
  // May return a plain function or a WebAssembly.Suspending wrapper.
  lower: (namespace: string, name: string, imp: HostImport) => unknown,
): WebAssembly.Imports {
  const importObject: Record<string, Record<string, unknown>> = {};
  for (const declared of WebAssembly.Module.imports(module)) {
    if (declared.kind !== 'function') {
      error(
        `guest imports ${declared.module}.${declared.name} (${declared.kind}); ` +
          `only function imports are supported`,
      );
    }
    const imp = tables[declared.module]?.[declared.name];
    (importObject[declared.module] ??= {})[declared.name] = imp !== undefined
      ? lower(declared.module, declared.name, imp)
      : () => error(`import ${declared.module}.${declared.name} is not available for this entry`);
  }
  return importObject as WebAssembly.Imports;
}

// Protocol spec: docs/protocol/output-data.md

import type { Reader } from '../contract/Reader.ts';
import { type ValueDescriptor, ValueType } from '../contracts/Contract.ts';

/** A leaf field a contract's builder requested, recorded for UI-schema generation. */
export interface FieldRequest {
  kind: 'bytes' | 'string' | 'number' | 'bool';
  key: string;
  /** Full path from the root (dot-joinable), so nested fields nest in the schema. */
  path: string[];
  desc: ValueDescriptor;
}

/** Map a descriptor's `type` string onto the Reader value type the builder expects. */
function valueTypeOf(desc: ValueDescriptor): ValueType {
  const type = desc.type ?? '';
  if (type === 'object') return ValueType.Object;
  if (type === 'array') return ValueType.Array;
  if (type.startsWith('bytes')) return ValueType.Bytes;
  if (type.startsWith('string')) return ValueType.String;
  if (type.startsWith('bool')) return ValueType.Bool;
  return ValueType.Number; // i32 / u32 / f64 / number / ...
}

function parseDescriptor(descriptor: string): ValueDescriptor {
  if (descriptor.length === 0) return {} as ValueDescriptor;
  try {
    return JSON.parse(descriptor) as ValueDescriptor;
  } catch {
    return {} as ValueDescriptor;
  }
}

function defaultString(desc: ValueDescriptor): string {
  const first = desc.options?.[0]?.value;
  return typeof first === 'string' ? first : '';
}

function defaultNumber(desc: ValueDescriptor): number {
  const first = desc.options?.[0]?.value;
  return typeof first === 'number' ? first : 0;
}

/**
 * A query `Reader` that records every leaf a contract's builder reads -- so the
 * explorer can derive a form schema via `getFields()` -- while returning the
 * user-provided value or a sensible default for each (default-then-refine).
 * This replaces the old `DefaultBuilderHost` on the Reader interface: the
 * contract navigates this Reader exactly like a concrete value tree, and we
 * capture the `(path, descriptor)` of each read.
 *
 * `values` is keyed by dot-joined path (e.g. "collateral.side"), matching the
 * flattened map the explorer already produces from the YAML editor.
 */
export class RecordingReader {
  private readonly fields: FieldRequest[] = [];

  constructor(private readonly values: Map<string, unknown> = new Map()) {}

  /** The reader callback to hand to `contract.buildParams` / `buildData`. */
  readonly reader = (_descriptor: string): Reader => this.objectNode([]);

  /** Every leaf field requested during the build, in order. */
  getFields(): FieldRequest[] {
    return this.fields;
  }

  private objectNode(path: string[]): Reader {
    return {
      type: ValueType.Object,
      keys: this.keysUnder(path),
      at: (key, descriptor) => this.at(path, key, descriptor),
    };
  }

  private at(parentPath: string[], key: string, descriptor: string): Reader {
    const desc = parseDescriptor(descriptor);
    const path = [...parentPath, key];
    const vt = valueTypeOf(desc);

    // Containers are navigation, not leaves -- mirror the old begin/end (no record).
    if (vt === ValueType.Object) return this.objectNode(path);
    if (vt === ValueType.Array) {
      return { type: ValueType.Array, length: 0, at: () => ({ type: ValueType.Null }) };
    }

    const kind: FieldRequest['kind'] = vt === ValueType.Bytes
      ? 'bytes'
      : vt === ValueType.String
      ? 'string'
      : vt === ValueType.Bool
      ? 'bool'
      : 'number';
    this.fields.push({ kind, key, path, desc });

    const provided = this.values.get(path.join('.'));
    switch (vt) {
      case ValueType.Bytes:
        return {
          type: ValueType.Bytes,
          value: provided instanceof Uint8Array ? provided : new Uint8Array(0),
        };
      case ValueType.String:
        return {
          type: ValueType.String,
          value: typeof provided === 'string' ? provided : defaultString(desc),
        };
      case ValueType.Number:
        return {
          type: ValueType.Number,
          value: typeof provided === 'number' ? provided : defaultNumber(desc),
        };
      default:
        return { type: ValueType.Bool, value: typeof provided === 'boolean' ? provided : false };
    }
  }

  /** Distinct next path segments present in the values map under `path`. */
  private keysUnder(path: string[]): string[] {
    const prefix = path.length > 0 ? path.join('.') + '.' : '';
    const seen = new Set<string>();
    for (const mapKey of this.values.keys()) {
      if (prefix !== '' && !mapKey.startsWith(prefix)) continue;
      const rest = prefix === '' ? mapKey : mapKey.slice(prefix.length);
      const segment = rest.split('.')[0];
      if (segment.length > 0) seen.add(segment);
    }
    return [...seen];
  }
}

// Protocol spec: docs/protocol/output-data.md
//
// A BuilderHost backed by a raw (nested) JS value, for generic builders that
// discover the params/data shape at build time -- notably the JSON
// walker/builder module, which calls `requestValueType` + `requestObjectKeys` /
// `requestArrayLength` to traverse an object of unknown shape and assemble its
// serialized form.
//
// Unlike DefaultBuilderHost (which holds a flattened dot-path map keyed by
// descriptor-driven requests), this host keeps the original value tree and
// resolves each request against the current position, tracked by begin/end
// object/array calls.

import type { BuilderHost, ValueDescriptor } from '../contracts/Contract.ts';
import { ValueType } from '../contracts/Contract.ts';

export class NestedBuilderHost implements BuilderHost {
  private readonly root: unknown;
  private readonly pathStack: string[] = [];

  constructor(root: unknown) {
    this.root = root;
  }

  /** Resolve the value at `[...pathStack, key]`, skipping empty segments. */
  private resolve(key: string): unknown {
    let cur: unknown = this.root;
    for (const seg of [...this.pathStack, key]) {
      if (seg.length === 0) continue;
      if (Array.isArray(cur)) {
        cur = cur[Number(seg)];
      } else if (cur !== null && typeof cur === 'object') {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  requestValueType(key: string, _desc: ValueDescriptor): ValueType {
    return typeOf(this.resolve(key));
  }

  requestBytes(key: string, _desc: ValueDescriptor): Uint8Array {
    const v = this.resolve(key);
    return v instanceof Uint8Array ? v : new Uint8Array(0);
  }

  requestString(key: string, _desc: ValueDescriptor): string {
    const v = this.resolve(key);
    return typeof v === 'string' ? v : '';
  }

  requestNumber(key: string, _desc: ValueDescriptor): number {
    const v = this.resolve(key);
    return typeof v === 'number' ? v : 0;
  }

  requestBool(key: string, _desc: ValueDescriptor): boolean {
    return this.resolve(key) === true;
  }

  requestArrayLength(key: string, _desc: ValueDescriptor): number {
    const v = this.resolve(key);
    return Array.isArray(v) ? v.length : 0;
  }

  requestObjectKeys(key: string, _desc: ValueDescriptor): string[] {
    const v = this.resolve(key);
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      return Object.keys(v as Record<string, unknown>);
    }
    return [];
  }

  beginObject(key: string): void {
    this.pathStack.push(key);
  }

  endObject(): void {
    this.pathStack.pop();
  }

  beginArray(key: string): void {
    this.pathStack.push(key);
  }

  endArray(): void {
    this.pathStack.pop();
  }

  validationError(_key: string, _message: string): void {
    // Generic builders don't validate; no-op.
  }
}

function typeOf(v: unknown): ValueType {
  if (v === null || v === undefined) return ValueType.Null;
  if (typeof v === 'boolean') return ValueType.Bool;
  if (typeof v === 'number') return ValueType.Number;
  if (typeof v === 'string') return ValueType.String;
  if (Array.isArray(v)) return ValueType.Array;
  return ValueType.Object;
}

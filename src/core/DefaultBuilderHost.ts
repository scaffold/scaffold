// Protocol spec: docs/protocol/output-data.md

import type { BuilderHost, ValueDescriptor } from '../contracts/Contract.ts';

/** Metadata about a field the builder requested. */
export interface FieldRequest {
  kind: 'bytes' | 'string' | 'number' | 'bool' | 'arrayLength' | 'objectKeys';
  key: string;
  /** Full path from root (for nested fields). */
  path: string[];
  desc: ValueDescriptor;
}

/** A validation error reported by the builder. */
export interface ValidationError {
  key: string;
  path: string[];
  message: string;
}

/**
 * A BuilderHost that supports the default-then-refine model.
 *
 * On the initial run with no user values, returns sensible defaults:
 * - bytes: empty Uint8Array
 * - string: first enum option value (if string) or ""
 * - number: first enum option value (if number) or 0
 * - bool: false
 * - arrayLength: 0
 *
 * User-provided values are keyed by dot-joined path (e.g. "collateral.side").
 */
export class DefaultBuilderHost implements BuilderHost {
  private readonly values: Map<string, unknown>;
  private readonly fields: FieldRequest[] = [];
  private readonly errors: ValidationError[] = [];
  private readonly pathStack: string[] = [];

  constructor(values?: Map<string, unknown>) {
    this.values = values ?? new Map();
  }

  private currentPath(key: string): string[] {
    return [...this.pathStack, key];
  }

  private pathKey(key: string): string {
    const parts = this.currentPath(key);
    return parts.join('.');
  }

  private recordField(
    kind: FieldRequest['kind'],
    key: string,
    desc: ValueDescriptor,
  ): void {
    this.fields.push({ kind, key, path: this.currentPath(key), desc });
  }

  requestBytes(key: string, desc: ValueDescriptor): Uint8Array {
    this.recordField('bytes', key, desc);
    const pk = this.pathKey(key);
    if (this.values.has(pk)) {
      return this.values.get(pk) as Uint8Array;
    }
    return new Uint8Array(0);
  }

  requestString(key: string, desc: ValueDescriptor): string {
    this.recordField('string', key, desc);
    const pk = this.pathKey(key);
    if (this.values.has(pk)) {
      return this.values.get(pk) as string;
    }
    // Default: first enum option value if it's a string, else ""
    if (desc.options && desc.options.length > 0) {
      const first = desc.options[0].value;
      if (typeof first === 'string') return first;
    }
    return '';
  }

  requestNumber(key: string, desc: ValueDescriptor): number {
    this.recordField('number', key, desc);
    const pk = this.pathKey(key);
    if (this.values.has(pk)) {
      return this.values.get(pk) as number;
    }
    // Default: first enum option value if it's a number, else 0
    if (desc.options && desc.options.length > 0) {
      const first = desc.options[0].value;
      if (typeof first === 'number') return first;
    }
    return 0;
  }

  requestBool(key: string, desc: ValueDescriptor): boolean {
    this.recordField('bool', key, desc);
    const pk = this.pathKey(key);
    if (this.values.has(pk)) {
      return this.values.get(pk) as boolean;
    }
    return false;
  }

  requestArrayLength(key: string, desc: ValueDescriptor): number {
    this.recordField('arrayLength', key, desc);
    const pk = this.pathKey(key);
    if (this.values.has(pk)) {
      return this.values.get(pk) as number;
    }
    return 0;
  }

  requestObjectKeys(key: string, desc: ValueDescriptor): string[] {
    this.recordField('objectKeys', key, desc);
    // The values map is flattened to dot-joined paths, so the keys of the
    // object at this path are the distinct next path segments under its
    // prefix. E.g. for { collateral: { side, amount } } the entries are
    // "collateral.side" / "collateral.amount", so the keys under "collateral"
    // are ["side", "amount"].
    const path = this.currentPath(key).filter((s) => s.length > 0);
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

  validationError(key: string, message: string): void {
    this.errors.push({ key, path: this.currentPath(key), message });
  }

  /** All field requests in order. */
  getFields(): FieldRequest[] {
    return this.fields;
  }

  /** All validation errors. */
  getErrors(): ValidationError[] {
    return this.errors;
  }
}

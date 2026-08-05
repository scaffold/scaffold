import { error } from '../util/functional.ts';
import {
  BoolSource,
  BytesSource,
  ListSource,
  MapSource,
  NumberSource,
  Source,
  StringSource,
  ValueType,
} from './values.ts';

// export type SourceObj = boolean | number | string | Uint8Array | readonly unknown[] | object;

export function createSource(value: boolean, path?: string): BoolSource;
export function createSource(value: number, path?: string): NumberSource;
export function createSource(value: string, path?: string): StringSource;
export function createSource(value: Uint8Array, path?: string): BytesSource;
export function createSource(value: unknown[], path?: string): ListSource;
export function createSource(value: object, path?: string): MapSource;
export function createSource(value: unknown, path?: string): Source;
export function createSource(value: unknown, path: string = ''): Source | undefined {
  switch (typeof value) {
    case 'undefined':
      return undefined;
    case 'boolean':
      return { type: ValueType.Bool, value };
    case 'number':
      return { type: ValueType.Number, value };
    case 'string':
      return { type: ValueType.String, value };
    case 'object':
      if (value === null) {
        throw new Error(`Unsupported value null at field ${path}`);
      }
      if (value instanceof Uint8Array) return { type: ValueType.Bytes, value };
      else if (Array.isArray(value)) {
        return {
          type: ValueType.List,
          length: value.length,
          at: (idx, _desc) => createSource(value[idx], `${path}.${idx}`),
        };
      } else {
        const entries = Object.entries(value);
        return {
          type: ValueType.Map,
          length: entries.length,
          entry: (idx, _desc) => {
            const entry = entries[idx];
            if (entry === undefined) return undefined;
            return { key: entry[0], value: createSource(entry[1], `${path}.${idx}`) };
          },
          at: (key, _desc) =>
            createSource((value as Record<string, unknown>)[key], `${path}.${key}`),
        };
      }
    default:
      throw new Error(`Unsupported type ${typeof value} at field ${path}`);
  }
}

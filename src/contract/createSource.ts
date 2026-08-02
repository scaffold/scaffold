import {
  BoolSource,
  BytesSource,
  ListSource,
  NumberSource,
  Source,
  StringSource,
  StructSource,
  ValueType,
} from './values.ts';

// export type SourceObj = boolean | number | string | Uint8Array | readonly unknown[] | object;

export function createSource(value: boolean): BoolSource;
export function createSource(value: number): NumberSource;
export function createSource(value: string): StringSource;
export function createSource(value: Uint8Array): BytesSource;
export function createSource(value: readonly unknown[]): ListSource;
export function createSource(value: object): StructSource;
export function createSource(value: unknown): Source;
export function createSource(value: unknown): Source {
  switch (typeof value) {
    case 'boolean':
      return { type: ValueType.Bool, value };
    case 'number':
      return { type: ValueType.Number, value };
    case 'string':
      return { type: ValueType.String, value };
    case 'object':
      if (value === null) {
        throw new Error(`Unsupported type ${typeof value}`);
      }
      if (value instanceof Uint8Array) return { type: ValueType.Bytes, value };
      else if (Array.isArray(value)) {
        return {
          type: ValueType.List,
          length: value.length,
          at: (idx, _desc) => createSource(value[idx]),
        };
      } else {
        return {
          type: ValueType.Struct,
          at: (key, _desc) => createSource((value as Record<string, unknown>)[key]),
        };
      }
    default:
      throw new Error(`Unsupported type ${typeof value}`);
  }
}

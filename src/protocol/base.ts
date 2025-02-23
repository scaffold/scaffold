// @deno-types="../../avro/index.d.ts"
import * as avro from '../../avro/index.js';

import { Hash } from '../util/Hash.ts';
import { bigint2binLe, bin2bigintLe } from '../util/bigint.ts';

class HashLogicalType extends avro.types.LogicalType {
  // constructor(schema: avro.Schema, opts?: any) {
  //   super(schema, opts);
  // }

  // readonly underlyingType: avro.Type = new avro.types.FixedType({
  //   name: 'Hash',
  //   type: 'fixed',
  //   size: 32,
  // });

  // protected _export(schema: avro.Schema) {}

  public fromBytes(bytes: Uint8Array) {
    return Hash.fromBytes(bytes);
  }

  protected override _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected override _toValue(hash: Hash) {
    return hash.toBytes();
  }
  protected override _resolve(type: any) {
    if (avro.Type.isType(type, 'fixed') && type.getSize() === 32) {
      return this._fromValue;
    }
  }
}

class Uint8ArrayLogicalType extends avro.types.LogicalType {
  public fromBytes(bytes: Uint8Array) {
    return bytes;
  }

  protected override _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected override _toValue(val: Uint8Array) {
    return val;
  }
  protected override _resolve(type: any) {
    if (avro.Type.isType(type, 'bytes')) {
      return this._fromValue;
    }
  }
}

class BigIntLogicalType extends avro.types.LogicalType {
  public fromBytes(bytes: Uint8Array) {
    const x = bin2bigintLe(bytes);
    return x & 1n ? -(x >> 1n) : x >> 1n;
  }

  protected override _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected override _toValue(num: bigint) {
    const x = num < 0n ? (-num << 1n) | 1n : num << 1n;
    return bigint2binLe(x);
  }
  protected override _resolve(type: any) {
    if (avro.Type.isType(type, 'bytes')) {
      return this._fromValue;
    }
  }
}

const logicalTypes = {
  HashLogicalType,
  Uint8ArrayLogicalType,
  BigIntLogicalType,
} as const;

type UnionType<
  S extends avro.schema.DefinedType,
  R extends { [name: string]: avro.Schema },
> = S extends 'null' ? null
  : S extends string ? { [K in S]: ObjectType<S, R> }
  : S extends { name: string } ? { [K in S['name']]: ObjectType<S, R> }
  : never;

export type ObjectType<
  S extends avro.Schema,
  R extends { [name: string]: avro.Schema },
> = S extends keyof R ? ObjectType<R[S], R>
  : S extends 'null' ? null
  : S extends 'boolean' ? boolean
  : S extends 'int' ? number
  : S extends 'long' ? bigint
  : S extends 'float' ? number
  : S extends 'double' ? number
  : S extends 'bytes' ? Uint8Array
  : S extends 'string' ? string
  : S extends { logicalType: keyof typeof logicalTypes } ? ReturnType<
      InstanceType<typeof logicalTypes[S['logicalType']]>['fromBytes']
    >
  : S extends avro.schema.RecordType ? {
      [K in S['fields'][number]['name']]: ObjectType<
        Extract<S['fields'][number], { name: K }>['type'],
        R
      >;
    }
  : S extends avro.types.LongType ? bigint
  : S extends avro.schema.EnumType ? S['symbols'][number]
  : S extends avro.schema.ArrayType ? ObjectType<S['items'], R>[]
  : S extends avro.schema.MapType ? Record<string, ObjectType<S['values'], R>>
  : S extends avro.schema.FixedType ? Uint8Array
  : S extends readonly avro.schema.DefinedType[] ? UnionType<S[number], R>
  : never;

export interface Coder<T> {
  decode(src: Uint8Array): T;
  encode(msg: T, allocator?: (size: number) => Uint8Array): Uint8Array;
}

export const rawCoder: Coder<Uint8Array> = {
  decode(src) {
    return src;
  },
  encode(msg, allocator = (size: number) => new Uint8Array(size)) {
    const arr = allocator(msg.byteLength);
    arr.set(msg);
    return arr;
  },
};

const long = avro.types.LongType.__with({
  fromBuffer: (buf: Uint8Array) => new DataView(buf.buffer).getBigInt64(0, true),
  toBuffer: (n: bigint) => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, n, true);
    return buf;
  },
  fromJSON: BigInt,
  toJSON: Number,
  isValid: (n: bigint) => typeof n === 'bigint',
  compare: (n1: bigint, n2: bigint) => {
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
  },
});

// noUnpack

export const registry = {
  hash: {
    name: 'hash',
    type: 'fixed',
    size: 32,
    logicalType: 'HashLogicalType',
  },
  bytes: { name: 'bytes', type: 'bytes', logicalType: 'Uint8ArrayLogicalType' },
  bigint: { name: 'bigint', type: 'bytes', logicalType: 'BigIntLogicalType' },

  Json: {
    type: 'record',
    name: 'Json',
    fields: [
      {
        name: 'value',
        type: [
          'null',
          'boolean',
          'long',
          'double',
          'string',
          { type: 'array', items: 'Json' },
          { type: 'map', values: 'Json' },
        ],
      },
    ],
  },

  // TODO: We want more than 64 bits (preferably 128) for account balances
  // Use a packed long: amount = ((encoding >> 7n) + 1n) << (encoding & ((1n << 7n) - 1n))
  // Small negatives are zero here so maybe something better
  // Or just use this structure:
  Amount: {
    name: 'Amount',
    type: 'record',
    fields: [
      { name: 'significand', type: 'long' },
      { name: 'exponent', type: 'long' },
    ],
  },

  BytesTreeEntry: {
    name: 'BytesTreeEntry',
    type: 'record',
    fields: [
      { name: 'key', type: 'bytes' },
      { name: 'node', type: 'BytesTree' },
    ],
  },

  BytesTree: {
    name: 'BytesTree',
    type: 'record',
    fields: [
      { name: 'value', 'type': ['null', 'bytes'] },
      { name: 'entries', 'type': { type: 'array', items: 'BytesTreeEntry' } },
    ],
  },

  long,
} as const;

export const makeMsg = <
  R extends { [name: string]: avro.Schema },
  Name extends avro.Schema & string & keyof R,
>(
  registry: R,
  name: Name,
): Coder<ObjectType<Name, R>> => {
  const types: { [key: string]: avro.Type } = {};
  Object.entries(registry).forEach(([key, schema]) =>
    Object.defineProperty(types, key, {
      configurable: true,
      enumerable: false,
      get: () => {
        delete types[key];
        const value = avro.Type.forSchema(schema, {
          registry: types,
          logicalTypes,
          assertLogicalTypes: true,
          wrapUnions: true,
          noAnonymousTypes: true,
        });
        Object.defineProperty(types, key, {
          configurable: true,
          enumerable: true,
          value,
        });
        return value;
      },
    })
  );
  const type = types[name];

  // const encodingCache = new WeakMap<ObjectType<Name, R> & object, Uint8Array>();
  // const encodingSymbol = Symbol('encoding');

  return {
    // name,
    // type,
    decode: (src: Uint8Array): ObjectType<Name, R> => type.decode(src).value,
    encode: (
      msg: ObjectType<Name, R>,
      allocator: (size: number) => Uint8Array = (size: number) => new Uint8Array(size),
    ) => {
      // Method 1
      const buf = type.toBuffer(msg);

      // // Method 2
      // let buf: Uint8Array | undefined;
      // if (typeof msg === 'object' && msg !== null) {
      //   buf = encodingCache.get(msg);
      //   if (buf === undefined) {
      //     buf = type.toBuffer(msg);
      //     encodingCache.set(msg, buf);
      //   }
      // } else {
      //   buf = type.toBuffer(msg);
      // }

      // // Method 3
      // let buf: Uint8Array | undefined;
      // if (typeof msg === 'object' && msg !== null) {
      //   buf = (msg as unknown as Record<typeof encodingSymbol, Uint8Array>)[
      //     encodingSymbol
      //   ];
      //   if (buf === undefined) {
      //     buf = type.toBuffer(msg);
      //     (msg as unknown as Record<typeof encodingSymbol, Uint8Array>)[
      //       encodingSymbol
      //     ] = buf;
      //   }
      // } else {
      //   buf = type.toBuffer(msg);
      // }

      // All methods:
      // TODO: Eliminate copy; write directly into arr.
      const arr = allocator(buf.byteLength);
      arr.set(buf);
      return arr;
    },
  };
};

/*
export const makeMsg = <
  R extends { [name: string]: avro.Schema },
  Name extends avro.Schema & string & keyof R,
>(
  _registry: R,
  _name: Name,
): Message<ObjectType<Name, R>> => ({
  // name,
  // type,
  decode: (src: Uint8Array): ObjectType<Name, R> => unpack(src),
  encode: (
    msg: ObjectType<Name, R>,
    allocator: (size: number) => Uint8Array = (size: number) =>
      new Uint8Array(size),
  ) => {
    // TODO: Eliminate copy; write directly into arr.
    const buf = pack(msg);
    const arr = allocator(buf.byteLength);
    arr.set(buf);
    return arr;
  },
});
*/

type MsgType<Name extends keyof typeof registry> = ObjectType<Name, typeof registry>;

export const BytesTree = makeMsg(registry, 'BytesTree');
export type BytesTree = MsgType<'BytesTree'>;

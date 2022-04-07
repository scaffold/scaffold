import { Buffer } from 'buffer';
// @deno-types="../avsc_types.d.ts"
import * as avro from 'avro';
import HashClass from './util/Hash.ts';

declare global {
  interface Crypto {
    randomUUID: () => string;
  }
}

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
    return HashClass.fromBytes(bytes);
  }

  protected _fromValue(buf: Buffer) {
    return this.fromBytes(buf);
  }
  protected _toValue(hash: HashClass) {
    return Buffer.from(hash.toBytes());
  }
  protected _resolve(type: any) {
    if (avro.Type.isType(type, 'fixed') && type.getSize() === 32) {
      return this._fromValue;
    }
  }

  // random() {
  //   return new HashLogicalType({ name: 'Hash', type: 'fixed', size: 32 });
  // }
}

class Uint8ArrayLogicalType extends avro.types.LogicalType {
  public fromBytes(bytes: Uint8Array) {
    return bytes;
  }

  protected _fromValue(buf: Buffer) {
    return this.fromBytes(buf);
  }
  protected _toValue(val: Uint8Array) {
    return Buffer.from(val);
  }
  protected _resolve(type: any) {
    if (avro.Type.isType(type, 'bytes')) {
      return this._fromValue;
    }
  }
}

const logicalTypes = {
  HashLogicalType,
  Uint8ArrayLogicalType,
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
  : S extends 'long' ? never
  : S extends 'float' ? number
  : S extends 'double' ? number
  : S extends 'bytes' ? Uint8Array
  : S extends 'string' ? string
  : S extends avro.types.LongType ? bigint
  : S extends { logicalType: keyof typeof logicalTypes } ? ReturnType<
    InstanceType<typeof logicalTypes[S['logicalType']]>['fromBytes']
  >
  : S extends avro.schema.RecordType ? {
    [K in S['fields'][number]['name']]: ObjectType<
      Extract<S['fields'][number], { name: K }>['type'],
      R
    >;
  }
  : S extends avro.schema.EnumType ? S['symbols'][number]
  : S extends avro.schema.ArrayType ? ObjectType<S['items'], R>[]
  : S extends avro.schema.MapType ? Record<string, ObjectType<S['values'], R>>
  : S extends avro.schema.FixedType ? Uint8Array
  : S extends readonly avro.schema.DefinedType[] ? UnionType<S[number], R>
  : never;

interface Message<T> {
  decode(src: Uint8Array): T;
  encode(allocator: (size: number) => Uint8Array, msg: T): Uint8Array;
}

const long = avro.types.LongType.__with({
  fromBuffer: (buf: Buffer) => buf.readBigInt64LE(),
  toBuffer: (n: bigint) => {
    const buf = Buffer.alloc(8);
    buf.writeBigInt64LE(n);
    return buf;
  },
  fromJSON: BigInt,
  toJSON: Number,
  isValid: (n: bigint) => typeof n == 'bigint',
  compare: (n1: bigint, n2: bigint) => {
    return n1 === n2 ? 0 : (n1 < n2 ? -1 : 1);
  },
});

export const registry = {
  Hash: {
    name: 'Hash',
    type: 'fixed',
    size: 32,
    logicalType: 'HashLogicalType',
  },
  bytes: { name: 'bytes', type: 'bytes', logicalType: 'Uint8ArrayLogicalType' },
  Amount: { name: 'Amount', type: 'long' },

  // LoadContract: { name: 'LoadContract', type: 'record', fields: [] },
  // SelfDurationContract: {
  //   name: 'SelfDurationContract',
  //   type: 'record',
  //   fields: [],
  // },
  // SelfInputsContract: {
  //   name: 'SelfInputsContract',
  //   type: 'record',
  //   fields: [],
  // },
  // SelfLicensesContract: {
  //   name: 'SelfLicensesContract',
  //   type: 'record',
  //   fields: [],
  // },
  // QuestionSpec: {
  //   name: 'QuestionSpec',
  //   type: 'record',
  //   fields: [
  //     {
  //       name: 'contract',
  //       type: [
  //         'QuestionSpec',
  //         'LoadContract',
  //         'SelfDurationContract',
  //         'SelfInputsContract',
  //         'SelfLicensesContract',
  //       ],
  //     },
  //     // { name: 'contract_hash', type: 'Hash' },
  //     { name: 'params', type: 'bytes' },
  //   ],
  // },
  QuestionSpec: {
    name: 'QuestionSpec',
    type: 'record',
    fields: [
      { name: 'contract_answer_hash', type: 'Hash' },
      { name: 'params', type: 'bytes' },
    ],
  },

  Neighbor: {
    name: 'Neighbor',
    type: 'record',
    fields: [
      { name: 'node_hash', type: 'Hash' },
      // { name: 'public_key', type: 'bytes' },
      { name: 'handled_protocols', type: { type: 'array', items: 'string' } },
    ],
  },
  InfoMessage: {
    name: 'InfoMessage',
    type: 'record',
    fields: [
      { name: 'public_key', type: 'bytes' },
      { name: 'node_nonce', type: 'bytes' },

      { name: 'name', type: 'string' },
      { name: 'client_name', type: 'string' },
      { name: 'protocol_version', type: 'string' },
      { name: 'age_ptr', type: 'string' },

      { name: 'neighbors', type: { type: 'array', items: 'Neighbor' } },
    ],
  },
  PingMessage: {
    name: 'PingMessage',
    type: 'record',
    fields: [
      { name: 'secret', type: 'Hash' },
    ],
  },
  PongMessage: {
    name: 'PongMessage',
    type: 'record',
    fields: [
      { name: 'secret', type: 'Hash' },
    ],
  },
  ConnectionSpec: {
    name: 'ConnectionSpec',
    type: 'record',
    fields: [
      { name: 'protocol', type: 'string' },
      { name: 'data', type: 'string' },
    ],
  },
  BridgeStartMessage: {
    name: 'BridgeStartMessage',
    type: 'record',
    fields: [
      { name: 'dst_node_hash', type: 'Hash' },
      { name: 'connection_spec', type: 'ConnectionSpec' },
    ],
  },
  BridgeEndMessage: {
    name: 'BridgeEndMessage',
    type: 'record',
    fields: [
      { name: 'src_node_hash', type: 'Hash' },
      { name: 'connection_spec', type: 'ConnectionSpec' },
    ],
  },
  SubscribeMessage: {
    // This message is purely informational; publishing licenses with incentive, which can be claimed by an answer to some question is the way to incentivize computation of an answer.
    name: 'SubscribeMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      { name: 'question', type: 'QuestionSpec' },
      // { name: 'child_question', type: 'QuestionSpec' },
      // // { name: 'destination', type: 'Hash' },
      // { name: 'expected_reward', type: 'long' },
    ],
  },
  UnsubscribeMessage: {
    // This message is purely informational; publishing licenses with incentive, which can be claimed by an answer to some question is the way to incentivize computation of an answer.
    name: 'UnsubscribeMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      { name: 'question', type: 'QuestionSpec' },
      // { name: 'child_question', type: 'QuestionSpec' },
      // // { name: 'destination', type: 'Hash' },
      // { name: 'expected_reward', type: 'long' },
    ],
  },
  License: {
    name: 'License',
    type: 'record',
    fields: [
      { name: 'question_hash', type: 'Hash' },
      { name: 'incentive', type: 'Amount' }, // Always positive; specifies incentive that a question is able to claim by using this answer in their inputs
    ],
  },
  PublishMessage: {
    name: 'PublishMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      // { name: 'question', type: 'QuestionSpec' }, // I think this can just be the question hash, since subscribers will know it?

      // Note that the answer in here behaves as an input - if it becomes non-canonical, this publication needs to become so as well.
      // TODO: Perhaps add it as an input? Does it even need to be separate?
      { name: 'question', type: 'QuestionSpec' },

      { name: 'inputs', type: { type: 'array', items: 'Hash' } },
      // { name: 'birth_proof', type: 'HashExpr' },
      { name: 'answer', type: 'bytes' },

      { name: 'licenses', type: { type: 'array', items: 'License' } },

      // If the timestamp is too far back, nothing really happens, but it must be greater than all the input timestamps.
      // If timestamp is in the future, it will be rejected and it won't be useful for proving first.
      // For questions with easy, rewarding answers (like epochs),
      //   the answer will be created as soon as possible after the required timestamp.
      { name: 'timestamp', type: 'long' },
    ],
  },
  CiteMessage: {
    name: 'CiteMessage',
    type: 'record',
    fields: [
      { name: 'payment_proof', type: 'Hash' },
    ],
  },
  CollateralMessage: {
    name: 'CollateralMessage',
    type: 'record',
    fields: [
      { name: 'publication_hash', type: 'Hash' },
      { name: 'collateral', type: 'long' },
    ],
  },
  BribeMessage: { name: 'BribeMessage', type: 'record', fields: [] },
  DerivedWorkMessage: {
    name: 'DerivedWorkMessage',
    type: 'record',
    fields: [
      { name: 'answer_hash', type: 'Hash' },
      { name: 'work_log2', type: 'int' },
    ],
  },
  HashExpr: {
    name: 'HashExpr',
    type: 'record',
    fields: [
      { name: 'pre_pad', type: 'bytes' },
      { name: 'parent', type: ['null', 'HashExpr'] },
      { name: 'post_pad', type: 'bytes' },
    ],
  },
  DhtJoinMessage: {
    name: 'DhtJoinMessage',
    type: 'record',
    fields: [
      { name: 'hash', type: 'Hash' },
    ],
  },
  Packet: {
    name: 'Packet',
    type: 'record',
    fields: [
      {
        name: 'message',
        type: [
          'InfoMessage',
          'PingMessage',
          'PongMessage',
          'BridgeStartMessage',
          'BridgeEndMessage',
          'SubscribeMessage',
          'UnsubscribeMessage',
          'PublishMessage',
          'CollateralMessage',
          'BribeMessage',
          'DhtJoinMessage',
        ],
      },
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
): Message<ObjectType<Name, R>> => {
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

  return {
    // name,
    // type,
    decode: (src: Uint8Array): ObjectType<Name, R> =>
      type.decode(Buffer.from(src)).value,
    encode: (
      allocator: (size: number) => Uint8Array,
      msg: ObjectType<Name, R>,
    ) => {
      // TODO: Eliminate copy; write directly into arr.
      const buf = type.toBuffer(msg);
      const arr = allocator(buf.byteLength);
      arr.set(buf);
      return arr;
    },
  };
};

type MsgType<Name extends keyof typeof registry> = ObjectType<
  Name,
  typeof registry
>;

export const Hash = makeMsg(registry, 'Hash');
export type Hash = MsgType<'Hash'>;
export const QuestionSpec = makeMsg(registry, 'QuestionSpec');
export type QuestionSpec = MsgType<'QuestionSpec'>;
export const Neighbor = makeMsg(registry, 'Neighbor');
export type Neighbor = MsgType<'Neighbor'>;
export const InfoMessage = makeMsg(registry, 'InfoMessage');
export type InfoMessage = MsgType<'InfoMessage'>;
export const PingMessage = makeMsg(registry, 'PingMessage');
export type PingMessage = MsgType<'PingMessage'>;
export const PongMessage = makeMsg(registry, 'PongMessage');
export type PongMessage = MsgType<'PongMessage'>;
export const ConnectionSpec = makeMsg(registry, 'ConnectionSpec');
export type ConnectionSpec = MsgType<'ConnectionSpec'>;
export const BridgeStartMessage = makeMsg(registry, 'BridgeStartMessage');
export type BridgeStartMessage = MsgType<'BridgeStartMessage'>;
export const BridgeEndMessage = makeMsg(registry, 'BridgeEndMessage');
export type BridgeEndMessage = MsgType<'BridgeEndMessage'>;
export const SubscribeMessage = makeMsg(registry, 'SubscribeMessage');
export type SubscribeMessage = MsgType<'SubscribeMessage'>;
export const UnsubscribeMessage = makeMsg(registry, 'UnsubscribeMessage');
export type UnsubscribeMessage = MsgType<'UnsubscribeMessage'>;
export const License = makeMsg(registry, 'License');
export type License = MsgType<'License'>;
export const PublishMessage = makeMsg(registry, 'PublishMessage');
export type PublishMessage = MsgType<'PublishMessage'>;
export const CollateralMessage = makeMsg(registry, 'CollateralMessage');
export type CollateralMessage = MsgType<'CollateralMessage'>;
export const BribeMessage = makeMsg(registry, 'BribeMessage');
export type BribeMessage = MsgType<'BribeMessage'>;
export const HashExpr = makeMsg(registry, 'HashExpr');
export type HashExpr = MsgType<'HashExpr'>;
export const DhtJoinMessage = makeMsg(registry, 'DhtJoinMessage');
export type DhtJoinMessage = MsgType<'DhtJoinMessage'>;
export const Packet = makeMsg(registry, 'Packet');
export type Packet = MsgType<'Packet'>;

// const buf = Question.encode((size) => new Uint8Array(size), {
//   contract: {
//     Question: {
//       contract: null,
//       contract_hash: HashClass.digest('abc'),
//       params: new Uint8Array([4, 5, 6]),
//     },
//   },
//   contract_hash: HashClass.digest('abc'),
//   params: new Uint8Array([1, 2, 3]),
// });
// console.log(buf);
// console.log(Question.decode(buf));

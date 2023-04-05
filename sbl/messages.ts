// @deno-types="../avro/index.d.ts"
import * as avro from 'avro';
import HashClass from './util/Hash.ts';

// declare global {
//   interface Crypto {
//     randomUUID: () => string;
//   }
// }

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

  protected _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected _toValue(hash: HashClass) {
    return hash.toBytes();
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

  protected _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected _toValue(val: Uint8Array) {
    return val;
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
  // : S extends 'long' ? never
  : S extends 'long' ? bigint
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
  encode(msg: T, allocator?: (size: number) => Uint8Array): Uint8Array;
}

const long = avro.types.LongType.__with({
  fromBuffer: (buf: Uint8Array) =>
    new DataView(buf.buffer).getBigInt64(0, true),
  toBuffer: (n: bigint) => {
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigInt64(0, n, true);
    return buf;
  },
  fromJSON: BigInt,
  toJSON: Number,
  isValid: (n: bigint) => typeof n == 'bigint',
  compare: (n1: bigint, n2: bigint) => {
    return n1 === n2 ? 0 : n1 < n2 ? -1 : 1;
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

  Amount: { name: 'Amount', type: 'long' },

  // BEGIN Nov 30

  Verifier: {
    name: 'Verifier',
    type: 'record',
    fields: [
      { name: 'contract_hash', type: 'Hash' },
      { name: 'params', type: 'bytes' },
    ],
  },
  BlockInput: {
    name: 'BlockInput',
    type: 'record',
    fields: [
      { name: 'amount', type: 'long' },
      { name: 'block_hash', type: 'Hash' },
    ],
  },
  BlockOutput: {
    // TODO: Array of AND-filters joined with OR?
    //   This allows timeouts: (verifier == X OR (timestamp > Y AND author == Z))
    name: 'BlockOutput',
    type: 'record',
    fields: [
      { name: 'amount', type: 'long' },
      { name: 'verifier', type: 'Verifier' },
      // { name: 'bill_to', type: ['null', 'Verifier'] },
      // { name: 'author', type: ['null', 'bytes'] },
      // { name: 'timestamp_gt', type: ['null', 'long'] },
      // { name: 'timestamp_lt', type: ['null', 'long'] },
    ],
  },
  Block: {
    name: 'Block',
    type: 'record',
    fields: [
      // { name: 'refs', type: { type: 'array', items: 'Hash' } }, // Basically claims with zero amount
      // TODO: Rename to predecessors / successors?
      { name: 'inputs', type: { type: 'array', items: 'BlockInput' } },
      { name: 'outputs', type: { type: 'array', items: 'BlockOutput' } },
      // The difference between the output amount sum and input amount sum is the unassigned output that must be claimed for any derived block to be canonical.

      { name: 'verifier', type: 'Verifier' },
      // { name: 'body', type: ['Publication', 'bytes'] },
      { name: 'body', type: 'bytes' },

      // Whether body satisfies the verifier or not
      { name: 'side', type: 'boolean' },

      // Maybe make this a hash of the remote generator, and optionally the RNG state?
      { name: 'isFreeMarket', type: 'boolean' },

      // If the timestamp is too far back, nothing really happens, but it must be greater than all the input timestamps.
      // If timestamp is in the future, it will be rejected and it won't be useful for proving first.
      // For questions with easy, rewarding answers (like epochs),
      //   the answer will be created as soon as possible after the required timestamp.
      { name: 'timestamp', type: 'long' },
    ],
    // A block implicitly adds collateral to the data availability contracts of all input/output/verifier.contract_hash hashes
    // Maybe put the verifier on the collateral claim?
  },
  BlockSet: {
    // BlockSets are only useful if a peer has all input & frontier blocks.
    // When you sign a BlockSet, you are saying that you have all inner BlockSets or can provide signatures of someone who does.
    name: 'BlockSet',
    type: 'record',
    fields: [
      // Must include ALL inputs.
      { name: 'inputs', type: { type: 'array', items: 'BlockInput' } },
      // Outputs with a negative amount (incentive) may be omitted.
      // This allows efficient full-network BlockSets to not have to include the entire balance data.
      { name: 'outputs', type: { type: 'array', items: 'BlockOutput' } },

      // Allowing BlockSets to have verifiers allows for a lot of fun things
      // { name: 'verifier', type: 'Verifier' },

      // Set of block hashes to start enumeration from. Enumeration goes back in time, terminating at blocks included in claims.
      { name: 'frontier', type: { type: 'array', items: 'Hash' } },
    ],
  },

  BidMessage: {
    name: 'BidMessage',
    type: 'record',
    fields: [
      { name: 'input', type: 'Verifier' },
      { name: 'output', type: 'Verifier' },
      { name: 'amount', type: 'long' },
    ],
  },
  PublicationMessage: {
    name: 'PublicationMessage',
    type: 'record',
    fields: [
      { name: 'block', type: 'Block' },
    ],
  },
  RequestBlockMessage: {
    name: 'RequestBlockMessage',
    type: 'record',
    fields: [
      { name: 'hash', type: 'Hash' },
    ],
  },

  // END Nov 30

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
  // Question: {
  //   name: 'Verifier',
  //   type: 'record',
  //   fields: [
  //     {
  //       name: 'contract',
  //       type: [
  //         'Verifier',
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

  Neighbor: {
    name: 'Neighbor',
    type: 'record',
    fields: [
      { name: 'node_hash', type: 'Hash' },
      // { name: 'public_key', type: 'bytes' },
      { name: 'handled_protocols', type: { type: 'array', items: 'string' } },
    ],
  },
  // TODO: Prevent replay attacks with a challenge/response thing here
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
      { name: 'handled_protocols', type: { type: 'array', items: 'string' } },

      { name: 'neighbors', type: { type: 'array', items: 'Neighbor' } },
    ],
  },
  PingMessage: {
    name: 'PingMessage',
    type: 'record',
    fields: [{ name: 'secret', type: 'Hash' }],
  },
  PongMessage: {
    name: 'PongMessage',
    type: 'record',
    fields: [{ name: 'secret', type: 'Hash' }],
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
    // This message is purely informational; publishing licenses with BlockOutput, which can be claimed by an answer to some question is the way to incentivize computation of an answer.
    name: 'SubscribeMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      { name: 'verifier', type: 'Verifier' },
      // { name: 'child_question', type: 'Verifier' },
      // // { name: 'destination', type: 'Hash' },
      // { name: 'expected_reward', type: 'long' },
    ],
  },
  UnsubscribeMessage: {
    // This message is purely informational; publishing licenses with BlockOutput, which can be claimed by an answer to some question is the way to incentivize computation of an answer.
    name: 'UnsubscribeMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      { name: 'question', type: 'Verifier' },
      // { name: 'child_question', type: 'Verifier' },
      // // { name: 'destination', type: 'Hash' },
      // { name: 'expected_reward', type: 'long' },
    ],
  },
  License: {
    name: 'License',
    type: 'record',
    fields: [
      { name: 'question', type: 'Verifier' },

      // Always positive; specifies BlockOutput that a question is able to BlockInput by using this answer in their inputs.
      // TODO: Make this Amount; not sure why it's not working yet.
      { name: 'BlockOutput', type: 'long' },
    ],
  },
  PublishMessage: {
    name: 'PublishMessage',
    type: 'record',
    fields: [
      // { name: 'question_hash', type: 'Hash' },
      // { name: 'question', type: 'Verifier' }, // I think this can just be the question hash, since subscribers will know it?

      // Note that the answer in here behaves as an input - if it becomes non-canonical, this publication needs to become so as well.
      // TODO: Perhaps add it as an input? Does it even need to be separate?
      { name: 'question', type: 'Verifier' },

      // { name: 'author_public_key', type: 'bytes' },

      { name: 'inputs', type: { type: 'array', items: 'Hash' } },
      // { name: 'birth_proof', type: 'HashExpr' },
      { name: 'data', type: 'bytes' },

      { name: 'licenses', type: { type: 'array', items: 'License' } },

      // If the timestamp is too far back, nothing really happens, but it must be greater than all the input timestamps.
      // If timestamp is in the future, it will be rejected and it won't be useful for proving first.
      // For questions with easy, rewarding answers (like epochs),
      //   the answer will be created as soon as possible after the required timestamp.
      { name: 'timestamp', type: 'long' },
    ],
  },
  ForwardingFeedback: {
    name: 'ForwardingFeedback',
    type: 'record',
    fields: [
      { name: 'answer_hash', type: 'Hash' },

      // Negative means you were too slow, by N ms.
      // Positive means you were quicker than everyone else by N ms.
      { name: 'relative_time_ms', type: 'int' },
    ],
  },
  CiteMessage: {
    name: 'CiteMessage',
    type: 'record',
    fields: [{ name: 'payment_proof', type: 'Hash' }],
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
    fields: [{ name: 'hash', type: 'Hash' }],
  },
  FeedbackMessage: {
    name: 'FeedbackMessage',
    type: 'record',
    fields: [
      // { name: 'code', type: 'Hash' },
      { name: 'msg_phrase', type: 'string' },
      { name: 'msg_detail', type: 'string' },

      // TODO: Make maps work
      // { name: 'props', type: 'map', values: 'string' },

      // Goodness is typically from -1 to 0.
      // 0 is inconsequential, like a debug or info message.
      // -1 is fatal; you can expect the connection to be severed.
      // Values lower than -1 mean the peer or connection will be blocked for some time.
      // Values between -1 and 0 are used for less significant warnings.
      // In general, goodness is additive, so 10 feedback messages of goodness -0.1 are comparable to a message of goodness -1.
      // Positive goodness can be used to signify positive feedback.
      { name: 'goodness', type: 'float' },
    ],
  },

  Packet: {
    name: 'Packet',
    type: 'record',
    fields: [
      {
        name: 'message',
        type: [
          'BidMessage',
          'PublicationMessage',
          'RequestBlockMessage',
          'InfoMessage',
          'PingMessage',
          'PongMessage',
          'BridgeStartMessage',
          'BridgeEndMessage',
          'SubscribeMessage',
          'UnsubscribeMessage',
          'PublishMessage',
          'ForwardingFeedback',
          'CollateralMessage',
          'BribeMessage',
          'DhtJoinMessage',
        ],
      },
    ],
  },

  DataContractParams: {
    name: 'DataContractParams',
    type: 'record',
    fields: [
      { name: 'hash', type: 'Hash' },
      { name: 'secret', type: 'bytes' },
    ],
  },

  // CollateralContractParams: {
  //   name: 'CollateralContractParams',
  //   type: 'record',
  //   fields: [
  //     { name: 'block_hash', type: 'Hash' },
  //   ],
  // },
  CollateralContractBody: {
    name: 'CollateralContractBody',
    type: 'record',
    fields: [
      { name: 'side', type: 'boolean' },
      { name: 'hint', type: 'bytes' },
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

  // const encodingCache = new WeakMap<ObjectType<Name, R> & object, Uint8Array>();
  // const encodingSymbol = Symbol('encoding');

  return {
    // name,
    // type,
    decode: (src: Uint8Array): ObjectType<Name, R> => type.decode(src).value,
    encode: (
      msg: ObjectType<Name, R>,
      allocator: (size: number) => Uint8Array = (size: number) =>
        new Uint8Array(size),
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

type MsgType<Name extends keyof typeof registry> = ObjectType<
  Name,
  typeof registry
>;

// export const Hash = makeMsg(registry, 'Hash');
// export type Hash = MsgType<'Hash'>;
export const Amount = makeMsg(registry, 'Amount');
export type Amount = MsgType<'Amount'>;
export const Verifier = makeMsg(registry, 'Verifier');
export type Verifier = MsgType<'Verifier'>;
export const BlockInput = makeMsg(registry, 'BlockInput');
export type BlockInput = MsgType<'BlockInput'>;
export const BlockOutput = makeMsg(registry, 'BlockOutput');
export type BlockOutput = MsgType<'BlockOutput'>;
export const Block = makeMsg(registry, 'Block');
export type Block = MsgType<'Block'>;
export const BlockSet = makeMsg(registry, 'BlockSet');
export type BlockSet = MsgType<'BlockSet'>;
export const BidMessage = makeMsg(registry, 'BidMessage');
export type BidMessage = MsgType<'BidMessage'>;
export const PublicationMessage = makeMsg(registry, 'PublicationMessage');
export type PublicationMessage = MsgType<'PublicationMessage'>;
export const RequestBlockMessage = makeMsg(registry, 'RequestBlockMessage');
export type RequestBlockMessage = MsgType<'RequestBlockMessage'>;
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
export const ForwardingFeedback = makeMsg(registry, 'ForwardingFeedback');
export type ForwardingFeedback = MsgType<'ForwardingFeedback'>;
export const CollateralMessage = makeMsg(registry, 'CollateralMessage');
export type CollateralMessage = MsgType<'CollateralMessage'>;
export const BribeMessage = makeMsg(registry, 'BribeMessage');
export type BribeMessage = MsgType<'BribeMessage'>;
export const HashExpr = makeMsg(registry, 'HashExpr');
export type HashExpr = MsgType<'HashExpr'>;
export const DhtJoinMessage = makeMsg(registry, 'DhtJoinMessage');
export type DhtJoinMessage = MsgType<'DhtJoinMessage'>;
export const FeedbackMessage = makeMsg(registry, 'FeedbackMessage');
export type FeedbackMessage = MsgType<'FeedbackMessage'>;
export const Packet = makeMsg(registry, 'Packet');
export type Packet = MsgType<'Packet'>;
export const DataContractParams = makeMsg(registry, 'DataContractParams');
export type DataContractParams = MsgType<'DataContractParams'>;
export const CollateralContractBody = makeMsg(
  registry,
  'CollateralContractBody',
);
export type CollateralContractBody = MsgType<'CollateralContractBody'>;

// const buf = Question.encode({
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

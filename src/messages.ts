import { avro } from '../deps.ts';
import { Hash } from './util/Hash.ts';
import { bigint2bin, bin2bigint } from './util/bigint.ts';

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
    const x = bin2bigint(bytes);
    return x & 1n ? -(x >> 1n) : x >> 1n;
  }

  protected override _fromValue(buf: Uint8Array) {
    return this.fromBytes(buf);
  }
  protected override _toValue(num: bigint) {
    const x = num < 0n ? (-num << 1n) | 1n : num << 1n;
    return bigint2bin(x);
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
  fromBuffer: (buf: Uint8Array) =>
    new DataView(buf.buffer).getBigInt64(0, true),
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

  Verifier: {
    name: 'Verifier',
    type: 'record',
    fields: [
      { name: 'contractHash', type: 'hash' },
      { name: 'params', type: 'bytes' },
    ],
  },
  BlockInput: {
    name: 'BlockInput',
    type: 'record',
    fields: [
      { name: 'blockHash', type: 'hash' },
      // TODO: Array? Or add a refs array to the block?
      // TODO: -1 if we're not claiming any output?
      { name: 'outputIdx', type: 'int' },
      // I don't think we necessarily need this
      // { name: 'amount', type: 'long' },

      { name: 'groupIdx', type: 'int' },
    ],
  },
  BlockOutput: {
    // TODO: Array of AND-filters joined with OR?
    //   This allows timeouts: (verifier == X OR (timestamp > Y AND author == Z))
    name: 'BlockOutput',
    type: 'record',
    fields: [
      { name: 'verifier', type: 'Verifier' },
      // { name: 'bill_to', type: ['null', 'Verifier'] },
      // { name: 'author', type: ['null', 'bytes'] },
      // { name: 'timestamp_gt', type: ['null', 'long'] },
      // { name: 'timestamp_lt', type: ['null', 'long'] },

      // A ppsitive amount means we're paying/incentivizing descendant blocks who claim this output.
      // A negative amount means descendant blocks who claim this output must pay us (with another positive input or negative output to make their block sum zero).
      { name: 'amount', type: 'bigint' },

      { name: 'detail', type: 'bytes' },

      { name: 'groupIdx', type: 'int' },
    ],
  },
  EpochInclusionProof: {
    name: 'EpochInclusionProof',
    type: 'record',
    fields: [
      { name: 'block_hash', type: 'hash' },
      { name: 'epoch_hash', type: 'hash' },
      { name: 'input_indices', type: { type: 'array', items: 'int' } },
    ],
  },
  Block: {
    name: 'Block',
    type: 'record',
    fields: [
      { name: 'frontierVote', type: 'hash' },

      // Blocks we depend upon but aren't inputting anything from
      { name: 'refs', type: { type: 'array', items: 'hash' } },

      // TODO: Rename to predecessors / successors?
      { name: 'inputs', type: { type: 'array', items: 'BlockInput' } },
      { name: 'outputs', type: { type: 'array', items: 'BlockOutput' } },
      // NO: The difference between the output amount sum and input amount sum is the unassigned output that must be claimed for any derived block to be canonical.
      //   Actually, any balance needs to be spent in an output (can just be the true verifier)

      // { name: 'verifier', type: 'Verifier' },
      // { name: 'body', type: ['Publication', 'bytes'] },
      // TODO: Move this to BlockInput? No, I don't think so.
      // TODO: Move this to BlockOutput detail? Maybe! In any case, it would be nice to be able to fetch the detail of an output without claiming it.
      // TODO: Accomplish this via hints? Add a requireHint() call? Allow collateral and/or hints to be embedded on the target block itself?
      // { name: 'body', type: 'bytes' },

      { name: 'bodies', type: { type: 'array', items: 'bytes' } },

      // Maybe make this a hash of the remote generator, and optionally the RNG state?
      // { name: 'is_free_market', type: 'boolean' },

      // { name: 'claimed_work', type: 'long' },

      // If the timestamp is too far back, nothing really happens, but it must be greater than all the input timestamps.
      // If timestamp is in the future, it will be rejected and it won't be useful for proving first.
      // For questions with easy, rewarding answers (like epochs),
      //   the answer will be created as soon as possible after the required timestamp.
      { name: 'timestamp', type: 'long' },
    ],
    // A block implicitly adds collateral to the data availability contracts of all input/output/verifier.contractHash hashes
    // Maybe put the verifier on the collateral claim?
  },

  Identification: {
    name: 'Identification',
    type: 'record',
    fields: [
      { name: 'publicKey', type: 'bytes' },
    ],
  },

  // TODO: Make a way for small updates (appending/dropping a neighbor, updating the bandwidth, updating userdata, etc.)
  // TODO: PeerBrief?
  PeerInfo: {
    name: 'PeerInfo',
    type: 'record',
    fields: [
      { name: 'timestamp', type: 'long' },

      { name: 'network', type: 'string' },
      { name: 'version', type: 'int' },
      { name: 'userdata', type: 'string' },
      { name: 'clientNonce', type: 'string' },

      // { name: 'agePtr', type: 'hash' },
      // { name: 'ageIdx', type: 'bigint' },

      { name: 'bandwidth', type: 'int' }, // In bytes per second

      // TODO: Add persistent signals here?
      { name: 'protocols', type: { type: 'array', items: 'string' } },
    ],
  },

  ConnectionSignal: {
    name: 'ConnectionSignal',
    type: 'record',
    fields: [
      { name: 'replyTo', type: 'hash' },
      { name: 'priority', type: 'int' },
      { name: 'payload', type: 'bytes' },
    ],
  },
  SignalPayload: {
    name: 'SignalPayload',
    type: 'record',
    fields: [
      { name: 'signalingNonce', type: 'bytes' },
      { name: 'srcClientNonce', type: 'string' },
      { name: 'srcProtocol', type: 'string' },
      { name: 'receivedIdxMask', type: 'bigint' },
      { name: 'signalIdx', type: 'int' },
      { name: 'signalData', type: 'string' },
    ],
  },

  Ping: {
    name: 'Ping',
    type: 'record',
    fields: [{ name: 'secret', type: 'hash' }],
  },
  Pong: {
    name: 'Pong',
    type: 'record',
    fields: [{ name: 'secret', type: 'hash' }],
  },

  ForwardingFeedback: {
    name: 'ForwardingFeedback',
    type: 'record',
    fields: [
      { name: 'hash', type: 'hash' },

      // Negative means you were too slow, by N ms.
      // Positive means you were quicker than everyone else by N ms.
      { name: 'relativeTimeMs', type: 'int' },
    ],
  },

  // TODO: Remove this; just use the raw public key bytes
  AccountContractParams: {
    name: 'AccountContractParams',
    type: 'record',
    fields: [
      { name: 'publicKey', type: 'bytes' }, // 33 bytes
    ],
  },

  DataContractParams: {
    name: 'DataContractParams',
    type: 'record',
    fields: [
      { name: 'hash', type: 'hash' },
      { name: 'secret', type: 'bytes' },
    ],
  },

  TimeParams: {
    name: 'TimeParams',
    type: 'record',
    fields: [
      { name: 'time', type: 'long' },
    ],
  },

  JsWasiEnvEntry: {
    name: 'JsWasiEnvEntry',
    type: 'record',
    fields: [
      { name: 'key', type: 'bytes' },
      { name: 'val', type: 'bytes' },
    ],
  },
  JsWasiFileEntry: {
    name: 'JsWasiFileEntry',
    type: 'record',
    fields: [
      { name: 'path', type: 'string' },
      { name: 'contents', type: 'bytes' },
    ],
  },
  JsWasiParams: {
    name: 'JsWasiParams',
    type: 'record',
    fields: [
      { name: 'argv', type: { type: 'array', items: 'bytes' } },
      { name: 'env', type: { type: 'array', items: 'JsWasiEnvEntry' } },
      { name: 'cwd', type: { type: 'array', items: 'bytes' } },
      { name: 'files', type: { type: 'array', items: 'JsWasiFileEntry' } },
      { name: 'stdinFrom', type: { type: 'array', items: 'bytes' } },
      { name: 'stdoutTo', type: { type: 'array', items: 'bytes' } },
      { name: 'stderrTo', type: { type: 'array', items: 'bytes' } },
    ],
  },

  LockWrapperEntry: {
    name: 'LockWrapperEntry',
    type: 'record',
    fields: [
      { name: 'from', type: 'bytes' },
      { name: 'to', type: { type: 'array', items: 'bytes' } },
    ],
  },
  LockWrapperParams: {
    name: 'LockWrapperParams',
    type: 'record',
    fields: [
      { name: 'development', type: 'boolean' },
      { name: 'host', type: 'string' },
      { name: 'mapping', type: { type: 'array', items: 'LockWrapperEntry' } },
      { name: 'wasi_params', type: 'JsWasiParams' },
    ],
  },

  FrontierTreeParams: {
    name: 'FrontierTreeParams',
    type: 'record',
    fields: [
      { name: 'level', type: 'int' },
    ],
  },
  FrontierTreeDetail: {
    name: 'FrontierTreeDetail',
    type: 'record',
    fields: [
      // Item 0 is the weight of blocks in the tree voting for frontierVote.
      // Item 1 is the weight of blocks in the tree voting for frontierVote.frontierVote.
      // ...
      { name: 'treeWeights', type: { type: 'array', items: 'bigint' } },

      // { name: 'input_tree_root', type: 'hash' },
      // { name: 'output_tree_root', type: 'hash' },

      // { name: 'input_count', type: 'int' }, // TODO: long
      // { name: 'output_count', type: 'int' }, // TODO: long

      // { name: 'block_count', type: 'int' }, // TODO: long
      // { name: 'claimed_work', type: 'long' },

      { name: 'consumedInputsRoot', type: 'FrontierTreeIoEntry' },
      { name: 'producedOutputsRoot', type: 'FrontierTreeIoEntry' },
    ],
  },

  FrontierTreeIoEntry: {
    name: 'FrontierTreeIoEntry',
    type: 'record',
    fields: [{
      name: 'branches',
      type: { type: 'array', items: 'FrontierTreeIoBranch' },
    }],
  },
  FrontierTreeIoBranch: {
    name: 'FrontierTreeIoBranch',
    type: 'record',
    fields: [
      { name: 'path', type: 'bigint' },
      { name: 'childHash', type: 'hash' }, // Either a block hash or another io entry hash
      { name: 'outputIdx', type: 'int' }, // -1 means the childHash is an entry hash; a non-negative number means it's a block hash
      { name: 'amount', type: 'bigint' }, // Either this output's amount, or the total output amount of all child outputs
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

export const Verifier = makeMsg(registry, 'Verifier');
export type Verifier = MsgType<'Verifier'>;
export const BlockInput = makeMsg(registry, 'BlockInput');
export type BlockInput = MsgType<'BlockInput'>;
export const BlockOutput = makeMsg(registry, 'BlockOutput');
export type BlockOutput = MsgType<'BlockOutput'>;
export const EpochInclusionProof = makeMsg(registry, 'EpochInclusionProof');
export type EpochInclusionProof = MsgType<'EpochInclusionProof'>;
export const Block = makeMsg(registry, 'Block');
export type Block = MsgType<'Block'>;
export const Identification = makeMsg(registry, 'Identification');
export type Identification = MsgType<'Identification'>;
export const PeerInfo = makeMsg(registry, 'PeerInfo');
export type PeerInfo = MsgType<'PeerInfo'>;
export const ConnectionSignal = makeMsg(registry, 'ConnectionSignal');
export type ConnectionSignal = MsgType<'ConnectionSignal'>;
export const SignalPayload = makeMsg(registry, 'SignalPayload');
export type SignalPayload = MsgType<'SignalPayload'>;
export const Ping = makeMsg(registry, 'Ping');
export type Ping = MsgType<'Ping'>;
export const Pong = makeMsg(registry, 'Pong');
export type Pong = MsgType<'Pong'>;
export const ForwardingFeedback = makeMsg(registry, 'ForwardingFeedback');
export type ForwardingFeedback = MsgType<'ForwardingFeedback'>;
export const AccountContractParams = makeMsg(registry, 'AccountContractParams');
export type AccountContractParams = MsgType<'AccountContractParams'>;
export const DataContractParams = makeMsg(registry, 'DataContractParams');
export type DataContractParams = MsgType<'DataContractParams'>;
export const TimeParams = makeMsg(registry, 'TimeParams');
export type TimeParams = MsgType<'TimeParams'>;
export const JsWasiParams = makeMsg(registry, 'JsWasiParams');
export type JsWasiParams = MsgType<'JsWasiParams'>;
export const LockWrapperParams = makeMsg(registry, 'LockWrapperParams');
export type LockWrapperParams = MsgType<'LockWrapperParams'>;
export const FrontierTreeParams = makeMsg(registry, 'FrontierTreeParams');
export type FrontierTreeParams = MsgType<'FrontierTreeParams'>;
export const FrontierTreeDetail = makeMsg(registry, 'FrontierTreeDetail');
export type FrontierTreeDetail = MsgType<'FrontierTreeDetail'>;
export const FrontierTreeIoEntry = makeMsg(registry, 'FrontierTreeIoEntry');
export type FrontierTreeIoEntry = MsgType<'FrontierTreeIoEntry'>;
export const FrontierTreeIoBranch = makeMsg(registry, 'FrontierTreeIoBranch');
export type FrontierTreeIoBranch = MsgType<'FrontierTreeIoBranch'>;

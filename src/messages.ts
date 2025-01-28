import { makeMsg, ObjectType, registry as baseRegistry } from './protocol/base.ts';

export const registry = {
  ...baseRegistry,

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
      // TODO: I think we might be able to remove blockHash+outputIdx, and just use frontierOutputIdx (rename it to outputIdx)
      // Any client holding block B should also be holding the parents of block B, so it'll be easy to trace the path.
      // We can also use refs to specify block hashes
      { name: 'blockHash', type: 'hash' },

      // TODO: Array? Or add a refs array to the block?
      // TODO: -1 if we're not claiming any output?
      { name: 'outputIdx', type: 'int' },

      // I don't think we necessarily need this
      // { name: 'amount', type: 'long' },

      // This is the output index, in this block's output space.
      // This means it can spend a self output.
      { name: 'utxoIdx', type: 'int' },

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

      // Provides per-input data for a generator consuming a number of outputs with the same verifier
      { name: 'detail', type: 'bytes' },

      { name: 'groupIdx', type: 'int' },
    ],
  },
  Squash: {
    // TODO: Array of AND-filters joined with OR?
    //   This allows timeouts: (verifier == X OR (timestamp > Y AND author == Z))
    name: 'Squash',
    type: 'record',
    fields: [
      { name: 'blockHash', type: 'hash' },

      // The output count that's not consumed by a following squash
      // If the blocks's inputs consume it, it's still counted here
      { name: 'newUtxoCount', type: 'int' },
    ],
  },
  Block: {
    name: 'Block',
    type: 'record',
    fields: [
      { name: 'parent', type: 'hash' },
      { name: 'squashes', type: { type: 'array', items: 'Squash' } },

      // This is the volume of self and all squashes.
      { name: 'volume', type: 'int' },

      // These indices are in the parent's post-output, pre-input utxo space
      // It does not include the parent's inputs, nor self's inputs
      { name: 'squashedUtxoIdxs', type: { type: 'array', items: 'int' } },

      // Item 0 is the weight of blocks in the tree voting for frontierVote.
      // Item 1 is the weight of blocks in the tree voting for frontierVote.frontierVote.
      // ...
      // TODO: Rename to squashedWeights
      // TODO: Should this include the self weight? If so, the ancestor weight can be 100% known.
      { name: 'treeWeights', type: { type: 'array', items: 'bigint' } },

      // TODO: Enable this?
      // For now just use an output
      // { name: 'squashIncentive', type: 'bigint' },

      // Blocks we depend upon but aren't inputting anything from
      { name: 'refs', type: { type: 'array', items: 'hash' } },

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
      /*
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

      // TODO: Recursive mask; each reference to a child also contains the parameters for regenerating it, so it can always be regenerated by anyone
      // TODO: Remove? I'm not sure if we need this, it can be calculated recursively
      // { name: 'frontierVoteUtxoCount', type: 'int' }, // TODO: bigint?

      // These indices are in the frontier vote's post-output, pre-input utxo space
      { name: 'spentUtxoIdxs', type: { type: 'array', items: 'int' } },
      // { name: 'spentUtxoMask', type: 'bytes' },

      // The output count of each subtree that's not consumed by a following subtree
      // If the parent blocks's inputs consume it, it's still counted here
      // TODO: This might be able to be removed if we can generate it from the tree children input's frontierOutputIdxs
      { name: 'subtreeNewUtxoCount', type: { type: 'array', items: 'int' } },

      // TODO: Remove, since we now have a frontierVoteOutputMask
      { name: 'consumedInputsRoot', type: 'FrontierTreeIoEntry' },
      { name: 'producedOutputsRoot', type: 'FrontierTreeIoEntry' },
       */
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
} as const;

type MsgType<Name extends keyof typeof registry> = ObjectType<Name, typeof registry>;

export const Verifier = makeMsg(registry, 'Verifier');
export type Verifier = MsgType<'Verifier'>;
export const BlockInput = makeMsg(registry, 'BlockInput');
export type BlockInput = MsgType<'BlockInput'>;
export const BlockOutput = makeMsg(registry, 'BlockOutput');
export type BlockOutput = MsgType<'BlockOutput'>;
export const Squash = makeMsg(registry, 'Squash');
export type Squash = MsgType<'Squash'>;
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

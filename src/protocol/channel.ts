import { makeMsg, ObjectType, registry as baseRegistry } from './base.ts';
import { registry as msgRegistry } from '../messages.ts';

const registry = {
  ...baseRegistry,

  Verifier: msgRegistry.Verifier,

  HashInfo: {
    name: 'HashInfo',
    type: 'record',
    fields: [
      { name: 'hash', type: 'hash' },
      // { name: 'outputValues', type: { type: 'array', items: 'float' } },
      { name: 'lagMs', type: 'int' },
    ],
  },

  Index: {
    name: 'Index',
    type: 'record',
    fields: [
      { name: 'hashes', type: { type: 'array', items: 'HashInfo' } },
    ],
  },

  PeerInit: {
    name: 'PeerInit',
    type: 'record',
    fields: [
      { name: 'timestamp', type: 'long' },

      { name: 'network', type: 'string' },
      { name: 'version', type: 'int' },
      { name: 'clientNonce', type: 'string' },

      // { name: 'agePtr', type: 'hash' },
      // { name: 'ageIdx', type: 'bigint' },

      // TODO: Add persistent signals here?
      { name: 'protocols', type: { type: 'array', items: 'string' } },
    ],
  },

  PeerUpdateUserData: {
    name: 'PeerUpdateUserData',
    type: 'record',
    fields: [
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
  },

  PeerUpdateBandwidth: {
    name: 'PeerUpdateBandwidth',
    type: 'record',
    fields: [
      // This is the maximum bandwidth that can flow to the peer.
      { name: 'bandwidth', type: 'int' }, // In bytes per second
    ],
  },

  PeerUpdateSeen: {
    name: 'PeerUpdateSeen',
    type: 'record',
    fields: [
      { name: 'hash', type: 'hash' },
    ],
  },

  // Lets a peer know how much we want to know about data hashing to some value
  PeerUpdateReqData: {
    name: 'PeerUpdateReqData',
    type: 'record',
    fields: [
      { name: 'hash', type: 'hash' },
      { name: 'weight', type: 'float' },
    ],
  },

  // Lets a peer know how much we want to know about arbitrary blocks
  PeerUpdateReqBlock: {
    name: 'PeerUpdateReqBlock',
    type: 'record',
    fields: [
      { name: 'weightBase', type: 'float' },
      { name: 'weightPerVolume', type: 'float' },
    ],
  },

  // Lets a peer know how much we want to know about replies to our published incentives
  PeerUpdateReqReply: {
    name: 'PeerUpdateReqReply',
    type: 'record',
    fields: [
      { name: 'weightBase', type: 'float' },
      { name: 'weightPerAmount', type: 'float' }, // Additional weight per coin of incentive
    ],
  },

  // Lets a peer know how much we want to know about unclaimed outputs (so we can generate)
  PeerUpdateReqGeneration: {
    name: 'PeerUpdateReqGeneration',
    type: 'record',
    fields: [
      { name: 'contractHash', type: 'hash' },
      { name: 'weightBase', type: 'float' },
      { name: 'weightPerAmount', type: 'float' }, // Additional weight per coin of incentive
    ],
  },

  // Lets a peer know how much we want to know about claimed outputs (so we can verify)
  PeerUpdateReqVerification: {
    name: 'PeerUpdateReqVerification',
    type: 'record',
    fields: [
      { name: 'contractHash', type: 'hash' },
      { name: 'weightBase', type: 'float' },
      { name: 'weightPerAmount', type: 'float' }, // Additional weight per coin of incentive
    ],
  },

  PeerUpdate: {
    name: 'PeerUpdate',
    type: 'record',
    fields: [
      { name: 'index', type: 'long' },
      {
        name: 'updates',
        type: {
          type: 'array',
          items: [
            'PeerInit',
            'PeerUpdateUserData',
            'PeerUpdateBandwidth',
            'PeerUpdateReqData',
            'PeerUpdateReqBlock',
            'PeerUpdateReqReply',
            'PeerUpdateReqGeneration',
            'PeerUpdateReqVerification',
          ],
        },
      },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = ObjectType<Name, typeof registry>;

export const Index = makeMsg(registry, 'Index');
export type Index = MsgType<'Index'>;
export const PeerInit = makeMsg(registry, 'PeerInit');
export type PeerInit = MsgType<'PeerInit'>;
export const PeerUpdateUserData = makeMsg(registry, 'PeerUpdateUserData');
export type PeerUpdateUserData = MsgType<'PeerUpdateUserData'>;
export const PeerUpdateBandwidth = makeMsg(registry, 'PeerUpdateBandwidth');
export type PeerUpdateBandwidth = MsgType<'PeerUpdateBandwidth'>;
export const PeerUpdateSeen = makeMsg(registry, 'PeerUpdateSeen');
export type PeerUpdateSeen = MsgType<'PeerUpdateSeen'>;
export const PeerUpdateReqData = makeMsg(registry, 'PeerUpdateReqData');
export type PeerUpdateReqData = MsgType<'PeerUpdateReqData'>;
export const PeerUpdateReqBlock = makeMsg(registry, 'PeerUpdateReqBlock');
export type PeerUpdateReqBlock = MsgType<'PeerUpdateReqBlock'>;
export const PeerUpdateReqReply = makeMsg(registry, 'PeerUpdateReqReply');
export type PeerUpdateReqReply = MsgType<'PeerUpdateReqReply'>;
export const PeerUpdateReqGeneration = makeMsg(registry, 'PeerUpdateReqGeneration');
export type PeerUpdateReqGeneration = MsgType<'PeerUpdateReqGeneration'>;
export const PeerUpdateReqVerification = makeMsg(registry, 'PeerUpdateReqVerification');
export type PeerUpdateReqVerification = MsgType<'PeerUpdateReqVerification'>;
export const PeerUpdate = makeMsg(registry, 'PeerUpdate');
export type PeerUpdate = MsgType<'PeerUpdate'>;

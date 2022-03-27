import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  EpochParams: {
    type: 'record',
    name: 'EpochParams',
    fields: [{ name: 'height', type: 'long' }],
  },
  EpochAnswer: {
    type: 'record',
    name: 'EpochAnswer',
    fields: [
      // This is the hash of the epoch at `height - 1`.
      { name: 'prior_hash', type: 'Hash' },

      // This is the hash of the epoch at `height - LSB(height)`.
      { name: 'skip_hash', type: 'Hash' },

      // This is the hash of events we want to be included in the chain.
      { name: 'events_hash', type: 'Hash' },
      // TODO: Timestamp?
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const EpochParams = base.makeMsg(registry, 'EpochParams');
export type EpochParams = MsgType<'EpochParams'>;
export const EpochAnswer = base.makeMsg(registry, 'EpochAnswer');
export type EpochAnswer = MsgType<'EpochAnswer'>;

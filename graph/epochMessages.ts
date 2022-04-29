import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  Params: {
    name: 'Params',
    type: 'record',
    fields: [
      { name: 'height', type: 'long' },
    ],
  },
  Answer: {
    name: 'Answer',
    type: 'record',
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

export const Params = base.makeMsg(registry, 'Params');
export type Params = MsgType<'Params'>;
export const Answer = base.makeMsg(registry, 'Answer');
export type Answer = MsgType<'Answer'>;

import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  CollatzParams: {
    type: 'record',
    name: 'CollatzParams',
    fields: [{ name: 'num', type: 'long' }],
  },
  CollatzAnswer: {
    type: 'record',
    name: 'CollatzAnswer',
    fields: [
      { name: 'stopping_time', type: 'long' },
      { name: 'maximum', type: 'long' },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const CollatzParams = base.makeMsg(registry, 'CollatzParams');
export type CollatzParams = MsgType<'CollatzParams'>;
export const CollatzAnswer = base.makeMsg(registry, 'CollatzAnswer');
export type CollatzAnswer = MsgType<'CollatzAnswer'>;

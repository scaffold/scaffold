import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  AccountParams: {
    type: 'record',
    name: 'AccountParams',
    fields: [{ name: 'idx', type: 'long' }],
  },
  AccountAnswer: {
    type: 'record',
    name: 'AccountAnswer',
    fields: [],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const AccountParams = base.makeMsg(registry, 'AccountParams');
export type AccountParams = MsgType<'AccountParams'>;
export const AccountAnswer = base.makeMsg(registry, 'AccountAnswer');
export type AccountAnswer = MsgType<'AccountAnswer'>;

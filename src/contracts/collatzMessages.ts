import * as base from '../protocol/base.ts';

const registry = {
  ...base.registry,
  Params: {
    name: 'Params',
    type: 'record',
    fields: [
      { name: 'num', type: 'long' },
    ],
  },
  Answer: {
    name: 'Answer',
    type: 'record',
    fields: [
      { name: 'stoppingTime', type: 'long' },
      { name: 'maximum', type: 'long' },
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

import * as base from '../src/messages.ts';

const registry = {
  ...base.registry,
  InfiniteChainParams: {
    name: 'InfiniteChainParams',
    type: 'record',
    fields: [{ name: 'x', type: 'long' }],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const InfiniteChainParams = base.makeMsg(
  registry,
  'InfiniteChainParams',
);
export type InfiniteChainParams = MsgType<'InfiniteChainParams'>;

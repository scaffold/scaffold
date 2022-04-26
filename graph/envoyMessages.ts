import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  Params: {
    name: 'Params',
    type: 'record',
    fields: [
      { name: 'question', type: 'QuestionSpec' },
      { name: 'nonce', type: 'Hash' },
    ],
  },
  Answer: {
    name: 'Answer',
    type: 'record',
    fields: [
      { name: 'publication', type: 'PublishMessage' },
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

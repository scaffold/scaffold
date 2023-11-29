import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,

  CollateralHintInputHash: {
    name: 'CollateralHintInputHash',
    type: 'record',
    fields: [{ name: 'input_idx', type: 'int' }],
  },
  CollateralHintVerifier: {
    name: 'CollateralHintVerifier',
    type: 'record',
    fields: [{ name: 'input_idx', type: 'int' }],
  },

  CollateralHint: {
    name: 'CollateralHint',
    type: 'record',
    fields: [
      {
        name: 'hint',
        type: [
          'CollateralHintInputHash',
          'CollateralHintVerifier',
        ],
      },
    ],
  },

  CollateralContractParams: {
    name: 'CollateralContractParams',
    type: 'record',
    fields: [{ name: 'block_hash', type: 'Hash' }],
  },
  CollateralContractDetail: {
    name: 'CollateralContractDetail',
    type: 'record',
    fields: [
      { name: 'public_key', type: 'bytes' }, // 33 bytes
      { name: 'hints', type: { type: 'array', items: 'bytes' } },
      {
        name: 'contest_type',
        type: {
          name: 'contest_type',
          type: 'enum',
          symbols: [
            'INVALIDATION',
            'VALIDATION',
            'FINAL',
          ],
        },
      },
      { name: 'passed', type: 'boolean' },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const CollateralHint = base.makeMsg(registry, 'CollateralHint');
export type CollateralHint = MsgType<'CollateralHint'>;
export const CollateralContractParams = base.makeMsg(
  registry,
  'CollateralContractParams',
);
export type CollateralContractParams = MsgType<'CollateralContractParams'>;
export const CollateralContractDetail = base.makeMsg(
  registry,
  'CollateralContractDetail',
);
export type CollateralContractDetail = MsgType<'CollateralContractDetail'>;

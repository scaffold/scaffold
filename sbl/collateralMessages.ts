import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,

  CollateralTargetInputHash: {
    name: 'CollateralTargetInputHash',
    type: 'record',
    fields: [{ name: 'input_idx', type: 'int' }],
  },
  CollateralTargetVerifier: {
    name: 'CollateralTargetVerifier',
    type: 'record',
    fields: [{ name: 'input_idx', type: 'int' }],
  },

  CollateralContest: {
    name: 'CollateralContest',
    type: 'record',
    fields: [
      {
        name: 'target',
        type: [
          'CollateralTargetInputHash',
          'CollateralTargetVerifier',
        ],
      },

      // If this is null, we're contesting ALL hints
      { name: 'hint', type: ['null', 'bytes'] },
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
      { name: 'contest', type: ['null', 'CollateralContest'] },
      {
        name: 'result',
        type: {
          name: 'Result',
          type: 'enum',
          symbols: [
            'VALID', // This contest makes the parent contest valid
            'INVALID', // This contest makes the parent contest invalid
            'INCONCLUSIVE', // This contest has no effect on the parent contest
          ],
        },
      },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

export const CollateralContest = base.makeMsg(registry, 'CollateralContest');
export type CollateralContest = MsgType<'CollateralContest'>;
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

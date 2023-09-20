import * as base from '~/sbl/messages.ts';

const registry = {
  ...base.registry,
  ClaimAllValid: {
    name: 'ClaimAllValid',
    type: 'record',
    fields: [],
  },
  ClaimRequestInputHash: {
    name: 'ClaimRequestInputHash',
    type: 'record',
    fields: [
      { name: 'input_idx', type: 'int' },
    ],
  },
  ClaimReplyInputHash: {
    name: 'ClaimReplyInputHash',
    type: 'record',
    fields: [
      { name: 'input_idx', type: 'int' },
      { name: 'hint', type: 'bytes' },
    ],
  },
  ClaimRequestChildHash: {
    name: 'ClaimRequestChildHash',
    type: 'record',
    fields: [
      { name: 'child_idx', type: 'int' },
    ],
  },
  ClaimReplyChildHash: {
    name: 'ClaimReplyChildHash',
    type: 'record',
    fields: [
      { name: 'child_idx', type: 'int' },
      { name: 'hint', type: 'bytes' },
    ],
  },
  ClaimVerificationFailed: {
    name: 'ClaimVerificationFailed',
    type: 'record',
    fields: [
      { name: 'input_idx', type: 'int' },
      { name: 'hint', type: 'bytes' },
    ],
  },
  ClaimVerificationPassed: {
    name: 'ClaimVerificationPassed',
    type: 'record',
    fields: [
      { name: 'input_idx', type: 'int' },
      { name: 'hint', type: 'bytes' },
    ],
  },
  ClaimRequestWorkProbe: {
    name: 'ClaimRequestWorkProbe',
    type: 'record',
    fields: [
      { name: 'position', type: 'bytes' },
    ],
  },
  ClaimReplyWorkProbe: {
    name: 'ClaimReplyWorkProbe',
    type: 'record',
    fields: [
      { name: 'facts', type: { type: 'array', items: 'bytes' } },
    ],
  },
  ClaimRequestInputProbe: {
    name: 'ClaimRequestInputProbe',
    type: 'record',
    fields: [
      // { name: 'position', type: 'bytes' },
    ],
  },
  ClaimReplyInputProbe: {
    name: 'ClaimReplyInputProbe',
    type: 'record',
    fields: [
      { name: 'facts', type: { type: 'array', items: 'bytes' } },
    ],
  },
  ClaimRequestOutputProbe: {
    name: 'ClaimRequestOutputProbe',
    type: 'record',
    fields: [
      // { name: 'position', type: 'bytes' },
    ],
  },
  ClaimReplyOutputProbe: {
    name: 'ClaimReplyOutputProbe',
    type: 'record',
    fields: [
      { name: 'facts', type: { type: 'array', items: 'bytes' } },
    ],
  },
  CollateralContractParams: {
    name: 'CollateralContractParams',
    type: 'record',
    fields: [{ name: 'fact_hash', type: 'Hash' }],
  },
  CollateralContractDetail: {
    name: 'CollateralContractDetail',
    type: 'record',
    fields: [
      { name: 'public_key', type: 'bytes' }, // 33 bytes
      {
        name: 'claim',
        type: [
          'ClaimAllValid',
          'ClaimRequestInputHash',
          'ClaimReplyInputHash',
          'ClaimRequestChildHash',
          'ClaimReplyChildHash',
          'ClaimVerificationFailed',
          'ClaimVerificationPassed',
          'ClaimRequestWorkProbe',
          'ClaimReplyWorkProbe',
          'ClaimRequestInputProbe',
          'ClaimReplyInputProbe',
          'ClaimRequestOutputProbe',
          'ClaimReplyOutputProbe',
        ],
      },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = base.ObjectType<
  Name,
  typeof registry
>;

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

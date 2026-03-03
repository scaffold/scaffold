import { makeMsg, ObjectType, registry as baseRegistry } from './protocol/base.ts';

const registry = {
  ...baseRegistry,

  CollateralHintFrontierHash: {
    name: 'CollateralHintFrontierHash',
    type: 'record',
    fields: [],
  },
  CollateralHintInputHash: {
    name: 'CollateralHintInputHash',
    type: 'record',
    fields: [{ name: 'inputIdx', type: 'int' }],
  },
  CollateralHintVerifier: {
    name: 'CollateralHintVerifier',
    type: 'record',
    fields: [{ name: 'groupIdx', type: 'int' }],
  },

  CollateralHint: {
    name: 'CollateralHint',
    type: 'record',
    fields: [
      {
        name: 'hint',
        type: [
          'CollateralHintFrontierHash',
          'CollateralHintInputHash',
          'CollateralHintVerifier',
        ],
      },
    ],
  },

  CollateralContractParams: {
    name: 'CollateralContractParams',
    type: 'record',
    fields: [{ name: 'blockHash', type: 'hash' }],
  },
  CollateralContractDetail: {
    name: 'CollateralContractDetail',
    type: 'record',
    fields: [
      { name: 'publicKey', type: 'bytes' }, // 33 bytes
      { name: 'hints', type: { type: 'array', items: 'DataTree' } },

      // When running a contract, hints are requested via getHint().
      // After getHint() calls returning the above sequence of hints, the vote signifies the next getHint() or finalize() call.
      // VALID_CHALLENGE and ALL_VALID_CONTEST signify getHint(..., BurdenOfProof.Invalidation) being the next call.
      // INVALID_CHALLENGE and ONE_VALID_CONTEST signify getHint(..., BurdenOfProof.Validation) being the next call.
      // FINAL_PASS signifies finalize(VERIFICATION_SUCCESS_FLAG) being the next call, meaning the contract passed.
      // FINAL_FAIL signifies finalize([someErr]) being the next call, meaning the contract failed.
      // FINAL_CONTEST isn't used at the moment, but it would signify us knowing finalize() being the next call, as opposed to getHint(), but not knowing if the contract passed or failed.
      {
        name: 'vote',
        type: {
          name: 'vote',
          type: 'enum',
          symbols: [
            'VALID_CHALLENGE', // Place collateral on an invalidation contest type AND validity
            'ALL_VALID_CONTEST', // Place collateral on an invalidation contest type
            'INVALID_CHALLENGE', // Place collateral on a validation contest type AND invalidity
            'ONE_VALID_CONTEST', // Place collateral on a validation contest type
            'FINAL_PASS', // Place collateral on a final contest type AND validity
            'FINAL_FAIL', // Place collateral on a final contest type AND invalidity
            'FINAL_CONTEST', // Place collateral on a final contest type
          ],
        },
      },
    ],
  },
} as const;

export type MsgType<Name extends keyof typeof registry> = ObjectType<Name, typeof registry>;

export const CollateralHint = makeMsg(registry, 'CollateralHint');
export type CollateralHint = MsgType<'CollateralHint'>;
export const CollateralContractParams = makeMsg(registry, 'CollateralContractParams');
export type CollateralContractParams = MsgType<'CollateralContractParams'>;
export const CollateralContractDetail = makeMsg(registry, 'CollateralContractDetail');
export type CollateralContractDetail = MsgType<'CollateralContractDetail'>;

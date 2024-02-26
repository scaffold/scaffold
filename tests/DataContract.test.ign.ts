// For easy-to-verify contracts in general:
//   Requestor asks for commitments. C(h, s) = c <-> HASH(plaintext) == h && HASH(plaintext | s | provider_public_key_hash) == c
//   The provider gives an initial claim of the validity of his commitment (collateral=1000).
//   Requestor challenges with a claim containing his payment (collateral=1).
//   In order to not lose his collateral, he must provide the plaintext as a hint.
//   It doesn't matter who steals/provides the plaintext, because the requestor claim payment always goes to the provider.

import { makeTest, waitForBlock } from './util.ts';
import { BlockService } from '../src/BlockService.ts';
import { Hash } from '../src/util/Hash.ts';
import {
  collateralHash,
  dataHash,
  rootHash,
  trueHash,
} from '../src/constants.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import {
  CollateralContractParams,
  DataContractParams,
} from '../src/messages.ts';
import { PeerManager } from '../src/PeerManager.ts';
import { KeyService } from '../src/KeyService.ts';
import { COLLATERAL_INPUT_IDX_INITIAL } from '../sbl/CollateralContract.ts';
import { mapOne } from '../src/util/functional.ts';
import { HashInversionService } from '../sbl/HashInversionService.ts';
import { FetchService } from '../src/FetchService.ts';
import { BlockExt } from '../src/BlockMeta.ts';
import { LitigationService } from '../src/LitigationService.ts';

Deno.test(
  { name: `an invalid body should have collateral posted against` },
  makeTest({}, async (testCtx, ctx) => {
    ctx.get(HashInversionService).provide(str2bin('abc'));

    const secret = Hash.random().toBytes();
    const commitment = await new Promise<BlockExt>((resolve) =>
      ctx.get(FetchService).fetch(
        {
          contractHash: dataHash,
          params: DataContractParams.encode({
            hash: Hash.digest('abc'),
            secret,
          }),
        },
        {},
        resolve,
      )
    );

    ctx.get(LitigationService).litigateBlock(commitment, false);
  }),
);

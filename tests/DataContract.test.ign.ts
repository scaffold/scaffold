// For easy-to-verify contracts in general:
//   Requestor asks for commitments. C(h, s) = c <-> HASH(plaintext) == h && HASH(plaintext | s | provider_public_key_hash) == c
//   The provider gives an initial claim of the validity of his commitment (collateral=1000).
//   Requestor challenges with a claim containing his payment (collateral=1).
//   In order to not lose his collateral, he must provide the plaintext as a hint.
//   It doesn't matter who steals/provides the plaintext, because the requestor claim payment always goes to the provider.

import { makeTest, waitForBlock } from './util.ts';
import { BlockService } from '../legacy2/BlockService.ts';
import { Hash } from '../src/util/Hash.ts';
import { collateralHash, dataHash, rootHash, trueHash } from '../legacy2/hashes.ts';
import { str2bin } from '../sbl/pathUtils.ts';
import { assertEquals, assertObjectMatch } from 'std-latest/testing/asserts.ts';
import { CollateralContractParams, DataContractParams } from '../legacy2/messages.ts';
import { PeerManager } from '../legacy2/PeerManager.ts';
import { KeyService } from '../legacy2/KeyService.ts';
import { COLLATERAL_INPUT_IDX_INITIAL } from '../sbl/CollateralContract.ts';
import { mapOne } from '../src/util/functional.ts';
import { HashInversionService } from '../sbl/HashInversionService.ts';
import { FetchService } from '../legacy2/FetchService.ts';
import { BlockExt } from '../legacy2/BlockMeta.ts';
import { LitigationService } from '../legacy2/LitigationService.ts';

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

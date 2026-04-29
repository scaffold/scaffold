// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import type { Verifier } from './BlockCreationModule.ts';
import { BlockStore } from './Block.ts';
import {
  BlockVerificationModule,
  type BlockVerificationProvider,
} from './BlockVerificationModule.ts';
import { ContractHostService } from './ContractHostService.ts';
import { ContractVerificationService } from './ContractVerificationService.ts';
import { OutputClaimService } from './OutputClaimService.ts';
import { ProtocolContext } from './ProtocolContext.ts';

/**
 * Wires BlockVerificationModule to:
 *  - BlockStore (block/output lookup)
 *  - OutputClaimService (claim resolution events)
 *  - ContractVerificationService (per-verifier dispatch with dedupe)
 */
export class BlockVerificationService extends BlockVerificationModule {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    const outputClaims = ctx.get(OutputClaimService);
    const contractVerification = ctx.get(ContractVerificationService);
    const contractHost = ctx.get(ContractHostService);

    const provider: BlockVerificationProvider = {
      getClaimCount: (blockHash: Hash) => {
        const block = store.get(blockHash);
        return block?.claims.length;
      },
      getVerifier: (targetBlock: Hash, outputIndex: number): Verifier | undefined => {
        const b = store.get(targetBlock);
        if (!b) return undefined;
        if (outputIndex < 0 || outputIndex >= b.outputs.length) return undefined;
        return b.outputs[outputIndex].verifier;
      },
      onResolution: (cb) => outputClaims.onResolution(cb),
      verifyContract: (blockHash: Hash, verifier: Verifier) =>
        contractVerification.verify(blockHash, verifier),
      getOutputs: (blockHash: Hash) => store.get(blockHash)?.outputs,
      getOutputNamespaces: (contractHash: Hash) => contractHost.getOutputNamespaces(contractHash),
    };

    super(provider);
  }
}

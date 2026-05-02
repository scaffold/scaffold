// Protocol spec: docs/protocol/computation.md

import { Hash } from '../util/Hash.ts';
import type { Output, Verifier } from './BlockCreationModule.ts';
import {
  Block,
  BlockStore,
  makeBlockStoreOutputSpace,
  resolveClaimToOutput,
} from './Block.ts';
import {
  ContractVerificationModule,
  type ContractVerificationProvider,
} from './ContractVerificationModule.ts';
import { type ExecutionResult } from './ContractHost.ts';
import { ContractHostService } from './ContractHostService.ts';
import { ExecutionQueueService } from './ExecutionQueueService.ts';
import { SamplingService } from './SamplingService.ts';
import { ProtocolContext } from './ProtocolContext.ts';
import type { VerifyingEnvProvider } from './ContractEnv.ts';
import { OutputSpaceModule } from './OutputSpace.ts';

// -- Verifying provider adapter ------------------------------------

/**
 * Adapts BlockStore into a VerifyingEnvProvider<Block>. Handed to the
 * ContractHost so VerifyingEnv can walk refs/anchors for data access.
 */
class VerifyingProviderAdapter implements VerifyingEnvProvider<Block> {
  private readonly outputSpace: OutputSpaceModule;

  constructor(private readonly store: BlockStore) {
    this.outputSpace = makeBlockStoreOutputSpace(store);
  }

  getBlock(hash: Hash): Block | undefined {
    return this.store.get(hash);
  }

  getOutputs(block: Block) {
    return block.outputs;
  }

  getClaims(block: Block) {
    return block.claims;
  }

  getRefs(block: Block) {
    return block.refs;
  }

  resolveClaim(block: Block, claimIndex: number): Output | undefined {
    return resolveClaimToOutput(block, claimIndex, this.store, this.outputSpace)?.output;
  }
}

// -- Service -------------------------------------------------------

/**
 * Wires ContractVerificationModule to ContractHost + ExecutionQueueService
 * + SamplingService + BlockStore.
 *
 * The host runs the contract; the queue schedules the task; sampling
 * supplies the priority and the total weight the budget derives from.
 *
 * Budget derivation mirrors the previous `ExecutionQueueService.enqueueVerification`:
 *
 *     budget = totalWeight(blockHash) * feeRate * msPerCostUnit
 *
 * See docs/protocol/execution-queue.md#verification-budget.
 */
export class ContractVerificationService extends ContractVerificationModule {
  constructor(ctx: ProtocolContext) {
    const host = ctx.get(ContractHostService);
    const queue = ctx.get(ExecutionQueueService);
    const sampling = ctx.get(SamplingService);
    const store = ctx.get(BlockStore);
    const feeRate = queue.feeRate;
    const msPerCostUnit = queue.msPerCostUnit;

    const verifyingProvider = new VerifyingProviderAdapter(store);

    const provider: ContractVerificationProvider = {
      runVerification: (blockHash: Hash, verifier: Verifier): Promise<ExecutionResult> => {
        const block = store.get(blockHash);
        if (!block) {
          return Promise.resolve({
            accepted: false,
            reason: 'block not found',
          });
        }
        const result = host.runVerifying({
          block,
          verifier,
          outputs: block.outputs,
          claims: block.claims,
          refs: block.refs,
          signer: block.signer,
          timestamp: block.timestamp,
        }, verifyingProvider);
        return Promise.resolve(result);
      },

      enqueue: (task) => queue.enqueue(task),

      budgetMs: (blockHash: Hash) => {
        const totalWeight = sampling.getTotalWeight(blockHash);
        if (totalWeight <= 0) return 0;
        return totalWeight * feeRate * msPerCostUnit;
      },

      priority: (blockHash: Hash, _verifier: Verifier) => {
        // Priority is per-block, shared across all its verifiers -- one
        // sample result tips the same tree regardless of which verifier ran.
        return sampling.getPriority(blockHash);
      },
    };

    super(provider);
  }
}

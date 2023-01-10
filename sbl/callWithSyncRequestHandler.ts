/*

import Context from './Context.ts';
import Hash from './util/Hash.ts';
import { Block, Verifier } from './messages.ts';
import { FulfillmentRegistry } from './registries.ts';
import IncentiveService from './IncentiveService.ts';

class NeedsMoreDataError extends Error {
  constructor() {
    super();
  }
}

const callWithSyncRequestHandler = async <T>(
  ctx: Context,
  verifier: Verifier,
  func: (
    handler: (contractHash: Hash, params: Uint8Array) => Uint8Array,
    notifier: (contractHash: Hash, params: Uint8Array) => void,
  ) => T | Promise<T>,
  onDone: (answer: T, inputs: Block[], durationMs: number) => void,
) => {
  try {
    const inputs: Block[] = [];
    const startTime = Date.now();
    const out = await func((contractHash: Hash, params: Uint8Array) => {
      const innerVerifier = { contract_hash: contractHash, params };
      const verifierHash = Hash.digest(Verifier.encode(innerVerifier));
      const blocks = ctx.get(FulfillmentRegistry).getOrWait(verifierHash);
      if (blocks instanceof Promise) {
        ctx.get(IncentiveService).incentivize(innerVerifier, 1n);
        // ctx.get(NodeService).getAll().forEach((node) =>
        //   node.defaultConn?.sendReliable({
        //     BidMessage: { verifier: innerVerifier, output: verifier },
        //   })
        // );

        blocks.then(() =>
          callWithSyncRequestHandler(ctx, verifier, func, onDone)
        );
        throw new NeedsMoreDataError();
      } else {
        const block = blocks[0];
        inputs.push(block);
        return block.body;
      }
    }, (contractHash: Hash, params: Uint8Array) => {
      const innerVerifier = { contract_hash: contractHash, params };
      const verifierHash = Hash.digest(Verifier.encode(verifier));
      const blocks = ctx.get(FulfillmentRegistry).get(verifierHash);
      if (!blocks) {
        ctx.get(IncentiveService).incentivize(innerVerifier, 1n);
        // ctx.get(NodeService).getAll().forEach((node) =>
        //   node.defaultConn?.sendReliable({
        //     BidMessage: { verifier: innerVerifier, output: verifier },
        //   })
        // );
      }
    });

    onDone(out, inputs, Date.now() - startTime);
  } catch (err) {
    if (err instanceof NeedsMoreDataError) {
      // Needs more data. Just wait for it.
    } else {
      throw err;
    }
  }
};

export default callWithSyncRequestHandler;

*/

import { Hash } from '../util/Hash.ts';
import { BlockStore } from '../core/Block.ts';
import { GossipModule, GossipProvider, SubscribableOutput, ResolvedClaimVerifier } from './GossipModule.ts';
import { verifierKey } from './UtxoIndex.ts';
import { ProtocolContext } from '../core/ProtocolContext.ts';

class GossipProviderAdapter implements GossipProvider {
  constructor(private readonly store: BlockStore) {}

  getSubscribableOutputs(hash: Hash): SubscribableOutput[] {
    const block = this.store.get(hash);
    if (!block) return [];

    // Determine self-claimed output indices
    const selfClaims = new Set(
      block.claims.filter((c) => c < block.outputs.length),
    );

    return block.outputs
      .map((o, i) => ({
        index: i,
        verifierKey: verifierKey(o.verifier.contract, o.verifier.params),
        value: o.value,
      }))
      .filter((_, i) => !selfClaims.has(i));
  }

  getResolvedClaimVerifiers(hash: Hash): ResolvedClaimVerifier[] {
    const block = this.store.get(hash);
    if (!block?.resolvedClaims) return [];

    return block.resolvedClaims
      .filter((rc) => !Hash.equals(rc.block, hash)) // exclude self-claims
      .map((rc) => {
        const source = this.store.get(rc.block);
        if (!source) return null;
        const output = source.outputs[rc.outputIndex];
        if (!output) return null;
        return {
          verifierKey: verifierKey(output.verifier.contract, output.verifier.params),
          value: output.value,
        };
      })
      .filter((x): x is ResolvedClaimVerifier => x !== null);
  }
}

/** GossipModule wired to BlockStore via ProtocolContext. */
export class GossipService extends GossipModule {
  constructor(ctx: ProtocolContext) {
    const store = ctx.get(BlockStore);
    super(new GossipProviderAdapter(store));
  }
}

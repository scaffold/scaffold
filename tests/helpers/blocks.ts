import { BLOB_CONTRACT } from '../../src/contract/static/Blob.ts';
import { Context } from '../../src/Context.ts';
import { AtomSerializer } from '../../src/graph/AtomSerializer.ts';
import { BlockStore } from '../../src/graph/BlockStore.ts';
import { AtomSource, AtomType, Block, BlockPayload, Output } from '../../src/graph/types.ts';
import { Hash } from '../../src/util/Hash.ts';

export interface PublishHarness {
  genesis: Block;
  publish(outputs: Output[], claims: bigint[]): Block;
  /** Publish `bytes` as a self-claimed BLOB_CONTRACT output; returns its content hash. */
  publishBlob(bytes: Uint8Array): Hash;
}

/** Ingests genesis and publishes hand-built blocks anchored to it. */
export function makePublishHarness(ctx: Context): PublishHarness {
  const store = ctx.get(BlockStore);
  const genesis = store.ingest({
    source: AtomSource.Genesis,
    receivedAt: 0,
    raw: ctx.config.genesis,
  });

  let timestampMs = 0;
  const publish = (outputs: Output[], claims: bigint[]): Block => {
    const payload: BlockPayload = {
      anchor: genesis.hash,
      chain: [{ weight: 0n, throughput: 0n }],
      aggregates: [],
      claims,
      refs: [],
      outputs,
      timestampMs: ++timestampMs,
    };
    const raw = ctx.get(AtomSerializer).serialize(AtomType.Block, payload);
    return store.ingest({ source: AtomSource.Remote, receivedAt: timestampMs, raw });
  };

  const publishBlob = (bytes: Uint8Array): Hash => {
    const hash = Hash.digest(bytes);
    publish([{ contract: BLOB_CONTRACT, params: hash.toBytes(), data: bytes, amount: 0n }], [0n]);
    return hash;
  };

  return { genesis, publish, publishBlob };
}

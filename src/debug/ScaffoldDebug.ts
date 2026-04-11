/**
 * Debug API exposed on window.__scaffold for DevTools introspection.
 *
 * Provides queryable access to the event log and internal state.
 * Designed to be called from Chrome DevTools console or MCP evaluate_script.
 */

import { Scaffold } from '../Scaffold.ts';
import { Hash } from '../util/Hash.ts';
import { bin2hex } from '../util/hex.ts';
import { EventLog, LogEntry, LogQuery } from '../core/EventLog.ts';
import { ZERO_HASH } from '../util/Hash.ts';

export interface BlockSummary {
  hash: string;
  anchor: string;
  canonical: boolean;
  depth: number;
  outputCount: number;
  claimCount: number;
  aggregateCount: number;
  totalValue: number;
  effectiveWeight: number;
}

export interface ScaffoldDebugAPI {
  /** The raw event log -- use log.query(), log.last(), log.forBlock() */
  log: EventLog;

  /** List all blocks with summary info */
  blocks(): BlockSummary[];

  /** Get detailed info for a block by hash prefix */
  block(hashPrefix: string): Record<string, unknown> | null;

  /** List only canonical blocks */
  canonical(): BlockSummary[];

  /** List all conflicts */
  conflicts(): { blockA: string; blockB: string }[];

  /** Get the canonical chain from tip to genesis */
  chain(): string[];

  /** Dump the current state as a single object (useful for snapshots) */
  snapshot(): Record<string, unknown>;

  /** Shorthand: last N log entries (default 20) */
  recent(n?: number): LogEntry[];

  /** Query log entries */
  query(filter: LogQuery): LogEntry[];

  /** Get all log entries for a specific block hash prefix */
  history(hashPrefix: string): LogEntry[];

  /** Query unspent outputs, optionally filtered by contract hash prefix */
  utxos(contractPrefix?: string): Record<string, unknown>[];

  /** List connected peers (when networking is active) */
  peers(): Record<string, unknown>[];

  /** Show the extended output vector for a block */
  outputSpace(hashPrefix: string): Record<string, unknown>[] | null;

  /** Summary stats */
  status(): Record<string, unknown>;
}

/**
 * Create a debug API bound to a Scaffold instance.
 */
export function createDebugAPI(scaffold: Scaffold): ScaffoldDebugAPI {
  const ctx = scaffold.context;
  const store = ctx.store;
  const consensus = ctx.consensus;
  const sampling = ctx.sampling;

  function resolveHash(prefix: string): Hash | null {
    const lower = prefix.toLowerCase();
    for (const block of [...store.values()]) {
      if (block.hash.toHex().toLowerCase().startsWith(lower)) {
        return block.hash;
      }
    }
    return null;
  }

  function blockSummary(hash: Hash): BlockSummary {
    const block = store.get(hash)!;
    const isCanonical = consensus.isCanonical(hash);
    const genesisHash = ctx.genesisHash;
    const depth = store.getAnchorDepth(hash, genesisHash) ?? -1;
    return {
      hash: block.hash.toHex(),
      anchor: block.anchor.toHex(),
      canonical: isCanonical,
      depth,
      outputCount: block.outputs.length,
      claimCount: block.claims.length,
      aggregateCount: block.aggregates.length,
      totalValue: block.outputs.reduce((sum, o) => sum + o.value, 0),
      effectiveWeight: consensus.getEffectiveWeight(hash),
    };
  }

  return {
    log: scaffold.eventLog,

    blocks(): BlockSummary[] {
      return [...store.values()].map((b) => blockSummary(b.hash));
    },

    block(hashPrefix: string): Record<string, unknown> | null {
      const hash = resolveHash(hashPrefix);
      if (!hash) return null;
      const block = store.get(hash);
      if (!block) return null;
      const isCanonical = consensus.isCanonical(hash);
      const genesisHash = ctx.genesisHash;
      const depth = store.getAnchorDepth(hash, genesisHash) ?? -1;
      return {
        hash: block.hash.toHex(),
        anchor: block.anchor.toHex(),
        canonical: isCanonical,
        depth,
        outputs: block.outputs.map((o, i) => ({
          index: i,
          contract: o.verifier.contract.toHex(),
          value: o.value,
          dataLength: o.data?.length ?? 0,
        })),
        claims: [...block.claims],
        aggregates: block.aggregates.map((a) => a.toHex()),
        refs: block.refs.map((r) => r.toHex()),
        effectiveWeight: consensus.getEffectiveWeight(hash),
        weightFactor: sampling.getWeightFactor(hash),
        conflicts: [...consensus.getConflicts(hash)],
      };
    },

    canonical(): BlockSummary[] {
      const view = consensus.getCanonicalView();
      const result: BlockSummary[] = [];
      for (const key of view) {
        const hash = Hash.fromPrimitive(key);
        result.push(blockSummary(hash));
      }
      return result;
    },

    conflicts(): { blockA: string; blockB: string }[] {
      const seen = new Set<string>();
      const results: { blockA: string; blockB: string }[] = [];
      for (const block of [...store.values()]) {
        const conflicts = consensus.getConflicts(block.hash);
        for (const rivalKey of conflicts) {
          const pair = [block.hash.toHex(), rivalKey as string].sort().join(':');
          if (!seen.has(pair)) {
            seen.add(pair);
            results.push({
              blockA: block.hash.toHex(),
              blockB: rivalKey as string,
            });
          }
        }
      }
      return results;
    },

    chain(): string[] {
      // Walk from canonical tip to genesis
      const canonicalView = consensus.getCanonicalView();
      let bestHash = ctx.genesisHash;
      let bestDepth = 0;
      for (const key of canonicalView) {
        const hash = Hash.fromPrimitive(key);
        const depth = store.getAnchorDepth(hash, ctx.genesisHash);
        if (depth !== undefined && depth > bestDepth) {
          bestDepth = depth;
          bestHash = hash;
        }
      }

      const chain: string[] = [];
      let cur = bestHash;
      while (store.has(cur)) {
        chain.push(cur.toHex());
        const block = store.get(cur)!;
        if (Hash.equals(cur, block.anchor)) break; // genesis
        cur = block.anchor;
      }
      return chain;
    },

    snapshot(): Record<string, unknown> {
      return {
        blockCount: [...store.values()].length,
        canonicalCount: [...consensus.getCanonicalView()].length,
        conflicts: this.conflicts(),
        chain: this.chain(),
        logSize: scaffold.eventLog.size,
      };
    },

    recent(n = 20): LogEntry[] {
      return scaffold.eventLog.last(n);
    },

    query(filter: LogQuery): LogEntry[] {
      return scaffold.eventLog.query(filter);
    },

    history(hashPrefix: string): LogEntry[] {
      return scaffold.eventLog.forBlock(hashPrefix);
    },

    utxos(contractPrefix?: string): Record<string, unknown>[] {
      const utxoIndex = ctx.utxoIndex;
      const results: Record<string, unknown>[] = [];
      // Walk all canonical blocks and collect their outputs with UTXO status
      for (const block of [...store.values()]) {
        if (!consensus.isCanonical(block.hash)) continue;
        for (let i = 0; i < block.outputs.length; i++) {
          const output = block.outputs[i];
          const contractHex = output.verifier.contract.toHex();
          if (contractPrefix && !contractHex.startsWith(contractPrefix.toLowerCase())) continue;
          const utxoEntries = utxoIndex.getByVerifier(output.verifier.contract, output.verifier.params);
          const isUnspent = utxoEntries.some(
            (e) => Hash.equals(e.blockHash, block.hash) && e.outputIndex === i,
          );
          if (isUnspent) {
            results.push({
              blockHash: block.hash.toHex(),
              outputIndex: i,
              contract: contractHex,
              params: bin2hex(output.verifier.params),
              value: output.value,
            });
          }
        }
      }
      return results;
    },

    peers(): Record<string, unknown>[] {
      // NetworkBridge is private on Scaffold, but we can access gossip peer state
      const gossip = ctx.gossip;
      const peerIds = gossip.getPeerIds();
      return peerIds.map((id) => ({ peerId: id }));
    },

    outputSpace(hashPrefix: string): Record<string, unknown>[] | null {
      const hash = resolveHash(hashPrefix);
      if (!hash) return null;
      const block = store.get(hash);
      if (!block) return null;

      // Own outputs
      const result: Record<string, unknown>[] = block.outputs.map((output, i) => ({
        index: i,
        contract: output.verifier.contract.toHex(),
        value: output.value,
        dataLength: output.data?.length ?? 0,
        source: 'own',
      }));

      // Walk anchor chain to show inherited outputs
      if (!Hash.equals(block.anchor, ZERO_HASH)) {
        const claimSet = new Set(
          block.claims.filter((c) => c >= block.outputs.length).map((c) => c - block.outputs.length),
        );
        // Simple walk: show direct anchor's own outputs
        const anchorBlock = store.get(block.anchor);
        if (anchorBlock) {
          for (let i = 0; i < anchorBlock.outputs.length; i++) {
            const o = anchorBlock.outputs[i];
            result.push({
              index: result.length,
              contract: o.verifier.contract.toHex(),
              value: o.value,
              dataLength: o.data?.length ?? 0,
              source: claimSet.has(i) ? 'claimed' : 'inherited',
              fromBlock: anchorBlock.hash.toHex(),
            });
          }
        }
      }
      return result;
    },

    status(): Record<string, unknown> {
      const allBlocks = [...store.values()];
      const canonicalView = consensus.getCanonicalView();
      return {
        totalBlocks: allBlocks.length,
        canonicalBlocks: [...canonicalView].length,
        logEntries: scaffold.eventLog.size,
        nextSeq: scaffold.eventLog.nextSeq,
        conflicts: this.conflicts().length,
        chainLength: this.chain().length,
      };
    },
  };
}

/**
 * Install the debug API on the global window object.
 * Call this after creating a Scaffold instance.
 */
export function installDebugAPI(scaffold: Scaffold): ScaffoldDebugAPI {
  const api = createDebugAPI(scaffold);
  if (typeof globalThis !== 'undefined') {
    (globalThis as any).__scaffold = api;
  }
  return api;
}

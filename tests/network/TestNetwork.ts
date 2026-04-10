/**
 * Enhanced multi-node test network with support for:
 * - Tick-based message delivery
 * - Network partitions
 * - Configurable per-link latency
 * - Transitive gossip propagation
 * - Convergence assertions
 */

import { assert, assertEquals, assertFalse } from '@std/assert';
import { Hash, HashPrimitive } from '../../src/util/Hash.ts';
import { Block } from '../../src/core/Block.ts';
import { BlockAwareness, PushAction } from '../../src/node/GossipModule.ts';
import { SimBlockResult, SimNode } from '../SimNetwork.ts';

/** Simple set-based block awareness tracker. */
class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();

  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }

  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

interface PendingMessage {
  from: string;
  to: string;
  block: Block;
  deliverAt: number;
}

export class TestNetwork {
  private readonly nodes = new Map<string, SimNode>();
  private pending: PendingMessage[] = [];
  private currentTick = 0;
  private readonly partitioned = new Set<string>();
  private readonly latencies = new Map<string, number>();
  private defaultLatency = 0;

  // -- Node Management ------------------------------------------------

  /** Create and register a node, optionally connecting gossip to all existing nodes. */
  addNode(id: string, connectToAll = true): SimNode {
    const node = new SimNode(id);
    this.nodes.set(id, node);

    if (connectToAll) {
      for (const [otherId, otherNode] of this.nodes) {
        if (otherId === id) continue;
        node.gossip.addPeer(otherId, otherId, new SetAwareness());
        otherNode.gossip.addPeer(id, id, new SetAwareness());
      }
    }

    return node;
  }

  /** Manually connect two nodes' gossip layers. */
  connectPeers(a: string, b: string): void {
    const nodeA = this.nodes.get(a);
    const nodeB = this.nodes.get(b);
    if (!nodeA || !nodeB) throw new Error(`Node not found: ${!nodeA ? a : b}`);
    nodeA.gossip.addPeer(b, b, new SetAwareness());
    nodeB.gossip.addPeer(a, a, new SetAwareness());
  }

  getNode(id: string): SimNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`Node ${id} not found`);
    return node;
  }

  get nodeIds(): string[] {
    return [...this.nodes.keys()];
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  // -- Block Operations -----------------------------------------------

  /** Deliver genesis directly to all nodes (bypasses gossip). */
  broadcastGenesis(genesis: Block): void {
    for (const [_, node] of this.nodes) {
      node.receiveBlock(genesis, null);
    }
  }

  /** Deliver a block directly to a specific node. */
  deliverDirect(
    block: Block,
    nodeId: string,
    fromPeer: string | null = null,
  ): SimBlockResult {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    return node.receiveBlock(block, fromPeer);
  }

  /** Deliver a block directly to all nodes (bypasses gossip, like old SimNetwork). */
  deliverToAll(block: Block, sourceNodeId: string): void {
    for (const [nodeId, node] of this.nodes) {
      const fromPeer = nodeId === sourceNodeId ? null : sourceNodeId;
      node.receiveBlock(block, fromPeer);
    }
  }

  /**
   * Submit a block to a source node and queue gossip propagation.
   * The source node receives the block as self-originated (fromPeer=null).
   */
  submitBlock(block: Block, sourceNodeId: string): SimBlockResult {
    const node = this.nodes.get(sourceNodeId);
    if (!node) throw new Error(`Node ${sourceNodeId} not found`);
    const result = node.receiveBlock(block, null);
    this.queuePushActions(sourceNodeId, block, result.pushActions);
    return result;
  }

  /**
   * Submit a block and immediately flush all gossip propagation.
   * Convenience for tests that don't need timing control.
   */
  submitAndFlush(block: Block, sourceNodeId: string): SimBlockResult {
    const result = this.submitBlock(block, sourceNodeId);
    this.flush();
    return result;
  }

  // -- Time & Propagation ---------------------------------------------

  /** Process all pending messages due at current tick, including transitive gossip. */
  propagate(): void {
    let rounds = 0;
    while (rounds < 1000) {
      const due = this.pending.filter((m) => m.deliverAt <= this.currentTick);
      this.pending = this.pending.filter((m) => m.deliverAt > this.currentTick);

      if (due.length === 0) break;

      for (const msg of due) {
        if (this.isPartitioned(msg.from, msg.to)) continue;
        const node = this.nodes.get(msg.to);
        if (!node) continue;
        if (node.store.has(msg.block.hash)) continue;

        const result = node.receiveBlock(msg.block, msg.from);
        this.queuePushActions(msg.to, msg.block, result.pushActions);
      }
      rounds++;
    }
  }

  /** Advance time by given ticks and process due messages. */
  tick(ticks = 1): void {
    this.currentTick += ticks;
    this.propagate();
  }

  /** Deliver ALL pending messages regardless of timing. Repeats until quiescent. */
  flush(): void {
    let rounds = 0;
    while (this.pending.length > 0 && rounds < 1000) {
      const batch = [...this.pending];
      this.pending = [];

      for (const msg of batch) {
        if (this.isPartitioned(msg.from, msg.to)) {
          // Re-queue partitioned messages so they can be delivered after heal
          this.pending.push(msg);
          continue;
        }
        const node = this.nodes.get(msg.to);
        if (!node) continue;
        if (node.store.has(msg.block.hash)) continue;

        const result = node.receiveBlock(msg.block, msg.from);
        this.queuePushActions(msg.to, msg.block, result.pushActions);
      }
      rounds++;
    }
  }

  /** Number of pending (undelivered) messages. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** Current simulation time. */
  get time(): number {
    return this.currentTick;
  }

  // -- Partitioning ---------------------------------------------------

  /** Partition two groups: messages between them are dropped. */
  partition(groupA: string[], groupB: string[]): void {
    for (const a of groupA) {
      for (const b of groupB) {
        this.partitioned.add(`${a}->${b}`);
        this.partitioned.add(`${b}->${a}`);
      }
    }
  }

  /** Heal partition between two groups. */
  heal(groupA: string[], groupB: string[]): void {
    for (const a of groupA) {
      for (const b of groupB) {
        this.partitioned.delete(`${a}->${b}`);
        this.partitioned.delete(`${b}->${a}`);
      }
    }
  }

  /** Heal all partitions. */
  healAll(): void {
    this.partitioned.clear();
  }

  /** Check if two nodes are partitioned. */
  isPartitioned(from: string, to: string): boolean {
    return this.partitioned.has(`${from}->${to}`);
  }

  // -- Latency --------------------------------------------------------

  /** Set one-way latency between two nodes (in ticks). */
  setLatency(from: string, to: string, ticks: number): void {
    this.latencies.set(`${from}->${to}`, ticks);
  }

  /** Set default latency for all links without explicit latency. */
  setDefaultLatency(ticks: number): void {
    this.defaultLatency = ticks;
  }

  // -- Sync Helper ----------------------------------------------------

  /**
   * Manually synchronize a block from one node to another.
   * Useful after partitions heal to manually propagate blocks.
   */
  syncBlock(hash: Hash, fromNodeId: string, toNodeId: string): SimBlockResult | null {
    const fromNode = this.nodes.get(fromNodeId);
    const toNode = this.nodes.get(toNodeId);
    if (!fromNode || !toNode) return null;

    const block = fromNode.store.get(hash);
    if (!block) return null;
    if (toNode.store.has(hash)) return null;

    return toNode.receiveBlock(block, fromNodeId);
  }

  /**
   * Sync all blocks from one node to another that the target is missing.
   * Delivers in store iteration order (which may not be topological).
   */
  syncAllBlocks(fromNodeId: string, toNodeId: string): void {
    const fromNode = this.nodes.get(fromNodeId);
    const toNode = this.nodes.get(toNodeId);
    if (!fromNode || !toNode) return;

    for (const block of fromNode.store.values()) {
      if (!toNode.store.has(block.hash)) {
        toNode.receiveBlock(block, fromNodeId);
      }
    }
  }

  // -- Assertions -----------------------------------------------------

  /** Assert all nodes have a block in their store. */
  assertAllHave(hash: Hash): void {
    for (const [id, node] of this.nodes) {
      assert(node.store.has(hash), `Node ${id} missing block ${hash.toHex().slice(0, 8)}`);
    }
  }

  /** Assert a specific node has a block. */
  assertNodeHas(nodeId: string, hash: Hash): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    assert(node.store.has(hash), `Node ${nodeId} missing block ${hash.toHex().slice(0, 8)}`);
  }

  /** Assert a specific node does NOT have a block. */
  assertNodeMissing(nodeId: string, hash: Hash): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} not found`);
    assertFalse(
      node.store.has(hash),
      `Node ${nodeId} should NOT have block ${hash.toHex().slice(0, 8)}`,
    );
  }

  /** Assert block is canonical on all nodes. */
  assertAllCanonical(hash: Hash): void {
    for (const [id, node] of this.nodes) {
      assert(
        node.consensus.isCanonical(hash),
        `Block ${hash.toHex().slice(0, 8)} not canonical on node ${id}`,
      );
    }
  }

  /** Assert block is NOT canonical on any node. */
  assertNoneCanonical(hash: Hash): void {
    for (const [id, node] of this.nodes) {
      assertFalse(
        node.consensus.isCanonical(hash),
        `Block ${hash.toHex().slice(0, 8)} should not be canonical on node ${id}`,
      );
    }
  }

  /** Assert all nodes have identical canonical views. */
  assertAllAgree(): void {
    const ids = [...this.nodes.keys()];
    if (ids.length < 2) return;

    const reference = [...this.nodes.get(ids[0])!.consensus.getCanonicalView()].sort();

    for (let i = 1; i < ids.length; i++) {
      const other = [...this.nodes.get(ids[i])!.consensus.getCanonicalView()].sort();
      assertEquals(
        reference,
        other,
        `Nodes ${ids[0]} and ${ids[i]} disagree on canonical view`,
      );
    }
  }

  /** Assert a specific subset of nodes agree on canonical view. */
  assertGroupAgrees(nodeIds: string[]): void {
    if (nodeIds.length < 2) return;

    const reference = [...this.nodes.get(nodeIds[0])!.consensus.getCanonicalView()].sort();

    for (let i = 1; i < nodeIds.length; i++) {
      const other = [...this.nodes.get(nodeIds[i])!.consensus.getCanonicalView()].sort();
      assertEquals(
        reference,
        other,
        `Nodes ${nodeIds[0]} and ${nodeIds[i]} disagree on canonical view`,
      );
    }
  }

  /** Get canonical view size for a node. */
  canonicalSize(nodeId: string): number {
    return this.nodes.get(nodeId)!.consensus.getCanonicalView().size;
  }

  // -- Private --------------------------------------------------------

  private queuePushActions(source: string, block: Block, actions: PushAction[]): void {
    for (const action of actions) {
      const latency = this.getLatency(source, action.peer);
      this.pending.push({
        from: source,
        to: action.peer,
        block,
        deliverAt: this.currentTick + latency,
      });
    }
  }

  private getLatency(from: string, to: string): number {
    return this.latencies.get(`${from}->${to}`) ?? this.defaultLatency;
  }
}

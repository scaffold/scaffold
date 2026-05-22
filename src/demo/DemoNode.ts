import { Hash } from '../util/Hash.ts';
import { Block, BlockStore, composeGenesisPacket } from '../core/Block.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { BlockCreationService } from '../core/BlockCreationService.ts';
import { BlockAwareness } from '../node/RoutingModule.ts';
import { Scaffold } from '../Scaffold.ts';

import { AnimalName, ANIMALS, deriveIdentity, Identity } from './Identity.ts';
import { makeStatusOutput } from './StatusContract.ts';
import { validateBlockPacket } from './ContractValidator.ts';
import { StatusIndex } from './StatusIndex.ts';

/** Simple set-based block awareness tracker for gossip. */
class SetAwareness implements BlockAwareness {
  private readonly known = new Set<string>();

  has(hash: Hash): boolean {
    return this.known.has(hash.toPrimitive());
  }

  add(hash: Hash): void {
    this.known.add(hash.toPrimitive());
  }
}

export class DemoNode {
  readonly identity: Identity;
  readonly scaffold: Scaffold;
  readonly statusIndex: StatusIndex;
  readonly peers = new Map<string, WebSocket>();

  tip: Block;

  constructor(animalName: AnimalName) {
    this.identity = deriveIdentity(animalName);
    this.statusIndex = new StatusIndex();

    // Initialize via Scaffold
    const genesisOutputs = ANIMALS.map((name) =>
      makeStatusOutput(deriveIdentity(name).publicKey, '')
    );
    const genesisBlock = composeGenesisPacket(genesisOutputs);
    this.scaffold = new Scaffold({
      genesis: genesisBlock,
      privateKey: this.identity.privateKey,
      // Demo blocks are user-driven; piggyback would otherwise spawn
      // competing claims on every status output, and DraftStrategy
      // generators on STATUS_CONTRACT (no registered generator) leak
      // timers because they block waiting for inputs that never arrive.
      enablePiggyback: false,
      enableGeneration: () => false,
    });
    this.tip = this.scaffold.context.store.get(this.scaffold.context.genesisHash)!;

    // Rebuild status index from genesis
    this.statusIndex.rebuild([this.tip]);
  }

  get store(): BlockStore {
    return this.scaffold.context.store;
  }

  get consensus(): ConsensusService {
    return this.scaffold.context.consensus;
  }

  get blockCreation(): BlockCreationService {
    return this.scaffold.context.blockCreation;
  }

  get routing(): import('../node/RoutingModule.ts').RoutingModule {
    return this.scaffold.context.routing;
  }

  /** Receive a parsed Block from a peer. Validate, accept if valid, forward to other peers. */
  receiveBlock(block: Block, fromPeer: string): void {
    if (this.store.has(block.hash)) return;

    try {
      validateBlockPacket(block, this.store);
    } catch (e) {
      console.debug('Rejected invalid block from peer:', (e as Error).message);
      return;
    }

    this.scaffold.context.processBlock(block, fromPeer);
    this.updateTipFromStore();
    this.rebuildStatusIndex();

    for (const [peerId, ws] of this.peers) {
      if (peerId === fromPeer) continue;
      if (ws.readyState === WebSocket.OPEN) {
        this.sendPacket(ws, block.raw);
      }
    }
  }

  /**
   * Publish a status update.
   *
   * targetName: whose status to update
   * message: the new status text
   *
   * The block is signed with this node's identity key. If targetName !== this node's
   * identity, the signature won't match and peers will reject it (but we send it anyway
   * for testing).
   */
  publishStatus(targetName: AnimalName, message: string): void {
    const targetIdentity = deriveIdentity(targetName);

    // Locate the current status output for `targetName`. The new draft
    // path expects (producer, outputIndex) directly rather than the
    // anchor-extended-vector index.
    const claimRef = this.statusIndex.findClaimRef(targetName, this.tip, this.store);
    if (claimRef === undefined) {
      throw new Error(`no status output found for ${targetName}`);
    }

    // Build through DraftManager directly: the narrow Scaffold.put
    // covers only "publish records under a verifier", and DemoNode
    // needs to pair a status output with a specific input claim.
    // Note: the test harness historically broadcast first, then
    // validated locally; the new flow inverts that
    // (DraftManager.solidify processes locally first), so peers
    // receive the block via the standard processBlock path.
    const draftManager = this.scaffold.context.draftManager;
    const draft = draftManager.addReady({
      claims: [claimRef],
      outputs: [makeStatusOutput(targetIdentity.publicKey, message)],
      declaredWeight: 1,
    });
    const result = draftManager.solidify([draft]);
    if (!result.ok) {
      throw new Error(`publishStatus failed: solidify did not produce a block`);
    }
    const block = result.block;

    // Send to all peers regardless of local validation (mirrors the
    // pre-refactor demo behaviour that broadcast even invalid blocks).
    for (const [_peerId, ws] of this.peers) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendPacket(ws, block.raw);
      }
    }

    // Validate locally (throws if invalid). Already in the local store
    // via DraftManager.solidify -> processBlock; this keeps the demo's
    // post-publish invariant.
    validateBlockPacket(block, this.store);
    this.updateTipFromStore();
    this.rebuildStatusIndex();
  }

  /** Register a new peer and sync current chain. */
  addPeer(peerId: string, ws: WebSocket): void {
    this.peers.set(peerId, ws);
    this.routing.addPeer(peerId, peerId, new SetAwareness());

    // Sync: send all blocks in chain order (excluding genesis, peers compute it themselves)
    const chain = this.getCanonicalChain();
    for (const block of chain.slice(1)) { // skip genesis
      this.sendPacket(ws, block.raw);
    }
  }

  /** Remove a peer. */
  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  /** Get the number of connected peers. */
  get peerCount(): number {
    return this.peers.size;
  }

  /** Send raw packet bytes over WebSocket. */
  private sendPacket(ws: WebSocket, raw: Uint8Array): void {
    ws.send(raw);
  }

  /** Update tip to the deepest block in the canonical chain. */
  private updateTipFromStore(): void {
    const canonical = this.consensus.getCanonicalView();
    let bestBlock = this.tip;
    let bestDepth = this.getDepth(this.tip);

    for (const key of canonical) {
      const block = this.store.get(Hash.fromPrimitive(key));
      if (block) {
        const depth = this.getDepth(block);
        if (depth > bestDepth) {
          bestDepth = depth;
          bestBlock = block;
        }
      }
    }
    this.tip = bestBlock;
  }

  /** Get the depth of a block (length of anchor chain). */
  private getDepth(block: Block): number {
    let depth = 0;
    let current: Block | undefined = block;
    while (current?.anchor) {
      depth++;
      current = this.store.get(current.anchor);
    }
    return depth;
  }

  /** Walk anchor chain from tip to genesis, return in genesis-first order. */
  getCanonicalChain(): Block[] {
    const chain: Block[] = [];
    let current: Block | undefined = this.tip;
    while (current) {
      chain.push(current);
      if (current.anchor) {
        current = this.store.get(current.anchor);
      } else {
        break;
      }
    }
    chain.reverse();
    return chain;
  }

  /** Rebuild the status index from the current canonical chain. */
  private rebuildStatusIndex(): void {
    const chain = this.getCanonicalChain();
    this.statusIndex.rebuild(chain);
  }
}

import { Hash, HashPrimitive } from '../util/Hash.ts';
import { Block, BlockStore, createBlock } from '../core/Block.ts';
import { BlockSpec } from '../core/BlockCreationModule.ts';
import { BlockReceivedResult } from '../core/Coordinator.ts';
import { ConsensusService } from '../core/ConsensusService.ts';
import { BlockCreationService } from '../core/BlockCreationService.ts';
import { GossipService } from '../core/GossipService.ts';
import { BlockAwareness } from '../core/GossipModule.ts';
import { deserialize, serialize } from '../core/BlockSerializer.ts';
import { Scaffold } from '../Scaffold.ts';

import { AnimalName, ANIMALS, deriveIdentity, Identity } from './Identity.ts';
import { makeStatusOutput } from './StatusContract.ts';
import { signBlock, SignedBlock } from './SignedBlock.ts';
import { validateSignedBlock, ValidationResult } from './ContractValidator.ts';
import { StatusIndex } from './StatusIndex.ts';

/** Wire message sent over WebSocket. */
export interface WireMessage {
  type: 'block';
  data: string; // serialize(block)
  signature: string; // base64-encoded 64-byte signature
}

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
  readonly signatureStore = new Map<HashPrimitive, Uint8Array>();
  readonly peers = new Map<string, WebSocket>();

  tip: Block;

  constructor(animalName: AnimalName) {
    this.identity = deriveIdentity(animalName);
    this.statusIndex = new StatusIndex();

    // Initialize via Scaffold
    const genesisOutputs = ANIMALS.map((name) =>
      makeStatusOutput(deriveIdentity(name).publicKey, '')
    );
    this.scaffold = new Scaffold({ genesis: { outputs: genesisOutputs } });
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

  get gossip(): GossipService {
    return this.scaffold.context.gossip;
  }

  /** Receive a signed block from a peer. Validate, accept if valid, forward to other peers. */
  receiveSignedBlock(sb: SignedBlock, fromPeer: string): void {
    // Skip if already known
    if (this.store.has(sb.block.hash)) return;

    // Validate
    const validation = validateSignedBlock(sb, this.store);
    if (!validation.ok) {
      // Reject invalid blocks from peers
      return;
    }

    // Accept: store signature, process through reactive layer
    this.signatureStore.set(sb.block.hash.toPrimitive(), sb.signature);
    this.scaffold.context.processBlock(sb.block, fromPeer);

    // Update tip
    this.updateTipFromStore();

    // Rebuild status index
    this.rebuildStatusIndex();

    // Forward to other peers
    for (const [peerId, ws] of this.peers) {
      if (peerId === fromPeer) continue;
      if (ws.readyState === WebSocket.OPEN) {
        this.sendSignedBlock(ws, sb);
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
  publishStatus(targetName: AnimalName, message: string): { ok: boolean; error?: string } {
    const targetIdentity = deriveIdentity(targetName);

    // Find the current status output for the target
    const claimIdx = this.statusIndex.findClaimIndex(targetName, this.tip, this.store);
    if (claimIdx === undefined) {
      return { ok: false, error: `no status output found for ${targetName}` };
    }

    // Build BlockSpec
    const ownOutputCount = 1;
    const spec: BlockSpec = {
      anchor: this.tip.hash,
      outputs: [makeStatusOutput(targetIdentity.publicKey, message)],
      claims: [{ index: ownOutputCount + claimIdx, value: 1 }],
      declaredWeight: 1,
      aggregates: [],
    };

    // Build block through protocol stack
    const buildResult = this.blockCreation.buildBlock(spec);
    if (!buildResult.ok) {
      return { ok: false, error: buildResult.error };
    }

    const block = createBlock(buildResult.blueprint, this.tip);
    const sb = signBlock(block, this.identity.privateKey);

    // Validate locally
    const validation = validateSignedBlock(sb, this.store);

    if (validation.ok) {
      // Accept locally
      this.signatureStore.set(block.hash.toPrimitive(), sb.signature);
      this.scaffold.context.processBlock(block);
      this.updateTipFromStore();
      this.rebuildStatusIndex();
    }

    // Send to all peers regardless of local validation
    for (const [_peerId, ws] of this.peers) {
      if (ws.readyState === WebSocket.OPEN) {
        this.sendSignedBlock(ws, sb);
      }
    }

    if (!validation.ok) {
      return { ok: false, error: validation.reason };
    }

    return { ok: true };
  }

  /** Register a new peer and sync current chain. */
  addPeer(peerId: string, ws: WebSocket): void {
    this.peers.set(peerId, ws);
    this.gossip.addPeer(peerId, peerId, new SetAwareness());

    // Sync: send all blocks in chain order (excluding genesis, peers compute it themselves)
    const chain = this.getCanonicalChain();
    for (const block of chain.slice(1)) { // skip genesis
      const sig = this.signatureStore.get(block.hash.toPrimitive());
      if (sig) {
        this.sendSignedBlock(ws, { block, signature: sig });
      }
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

  /** Send a signed block over WebSocket. */
  private sendSignedBlock(ws: WebSocket, sb: SignedBlock): void {
    const msg: WireMessage = {
      type: 'block',
      data: serialize(sb.block),
      signature: uint8ToBase64(sb.signature),
    };
    ws.send(JSON.stringify(msg));
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

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

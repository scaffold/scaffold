import { Hash, ZERO_HASH } from '../util/Hash.ts';
import { Block, BlockStore } from '../core/Block.ts';
import { Output } from '../core/BlockCreationModule.ts';
import { ANIMALS, AnimalName, deriveIdentity } from './Identity.ts';
import { statusHash, decodeStatusData } from './StatusContract.ts';

/**
 * UTXO tracker for status messages.
 * Tracks the latest status message for each animal identity.
 */
export class StatusIndex {
  private statuses = new Map<AnimalName, string>();
  private subscriptions = new Set<AnimalName>();
  private onStatusChange: ((name: AnimalName, message: string) => void) | undefined;

  /** Rebuild the index from a canonical chain (genesis to tip). */
  rebuild(canonicalChain: Block[]): void {
    this.statuses.clear();

    for (const block of canonicalChain) {
      for (const output of block.outputs) {
        if (Hash.equals(output.contract, statusHash)) {
          const { publicKey, message } = decodeStatusData(output.data);
          const name = publicKeyToAnimalName(publicKey);
          if (name) {
            const oldMessage = this.statuses.get(name);
            this.statuses.set(name, message);
            if (oldMessage !== message && this.subscriptions.has(name) && this.onStatusChange) {
              this.onStatusChange(name, message);
            }
          }
        }
      }
    }
  }

  /**
   * Find the claim index for a given identity's current status output
   * in the extended output vector of tipBlock.
   *
   * Returns the raw index into the tip's extended vector.
   * The caller must add ownOutputCount when constructing the BlockSpec claim.
   */
  findClaimIndex(name: AnimalName, tipBlock: Block, store: BlockStore): number | undefined {
    const identity = deriveIdentity(name);
    const extended = collectExtendedOutputs(tipBlock, store);

    for (let i = 0; i < extended.length; i++) {
      if (Hash.equals(extended[i].contract, statusHash)) {
        const { publicKey } = decodeStatusData(extended[i].data);
        if (bytesEqual(publicKey, identity.publicKey)) {
          return i;
        }
      }
    }

    return undefined;
  }

  /** Get the current status message for an identity. */
  getStatus(name: AnimalName): string | undefined {
    return this.statuses.get(name);
  }

  /** Get all known statuses. */
  getAllStatuses(): Map<AnimalName, string> {
    return new Map(this.statuses);
  }

  /** Subscribe to status changes for an identity. */
  subscribe(name: AnimalName): void {
    this.subscriptions.add(name);
  }

  /** Unsubscribe from status changes for an identity. */
  unsubscribe(name: AnimalName): void {
    this.subscriptions.delete(name);
  }

  /** Set the callback for status changes. */
  setOnStatusChange(cb: (name: AnimalName, message: string) => void): void {
    this.onStatusChange = cb;
  }
}

/**
 * Collect the full extended output vector of a block.
 * Extended vector = [own outputs, surviving anchor outputs after claims]
 */
function collectExtendedOutputs(block: Block, store: BlockStore): Output[] {
  const result: Output[] = [...block.outputs];

  if (Hash.equals(block.anchor, ZERO_HASH)) {
    return result;
  }

  const anchorBlock = store.get(block.anchor);
  if (!anchorBlock) return result;

  const anchorOutputs = collectExtendedOutputs(anchorBlock, store);

  for (let i = 0; i < anchorOutputs.length; i++) {
    if (!block.claimMask.get(i)) {
      result.push(anchorOutputs[i]);
    }
  }

  return result;
}

/** Map a compressed public key to its animal name, or undefined. */
function publicKeyToAnimalName(publicKey: Uint8Array): AnimalName | undefined {
  for (const name of ANIMALS) {
    const identity = deriveIdentity(name);
    if (bytesEqual(identity.publicKey, publicKey)) {
      return name;
    }
  }
  return undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

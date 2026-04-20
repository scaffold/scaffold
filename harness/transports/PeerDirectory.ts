/**
 * Live in-process view of the coordinator's peer manifest. Applications
 * poll the manifest file periodically and expose a cheap lookup by
 * address or pubkey hex.
 */

import type { PeerEntry } from '../types.ts';
import { readPeerManifest } from '../peerManifest.ts';

export interface PeerDirectoryOptions {
  path: string;
  pollIntervalMs?: number;
  onChange?: (peers: readonly PeerEntry[]) => void;
}

export class PeerDirectory {
  private peersByAddress: Map<string, PeerEntry> = new Map();
  private peersByPubkey: Map<string, PeerEntry> = new Map();
  private allPeers: PeerEntry[] = [];
  private timer: number | undefined;
  private readonly path: string;
  private readonly pollIntervalMs: number;
  private readonly onChange?: (peers: readonly PeerEntry[]) => void;
  private lastWrittenAt = -1;

  constructor(opts: PeerDirectoryOptions) {
    this.path = opts.path;
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.onChange = opts.onChange;
  }

  /** Start polling and return a promise that resolves after the first load. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch(() => {
        // swallow; transient fs errors are fine to retry next tick
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  getByAddress(address: string): PeerEntry | undefined {
    return this.peersByAddress.get(address);
  }

  getByPubkey(pubkeyHex: string): PeerEntry | undefined {
    return this.peersByPubkey.get(pubkeyHex);
  }

  snapshot(): readonly PeerEntry[] {
    return this.allPeers;
  }

  private async refresh(): Promise<void> {
    const manifest = await readPeerManifest(this.path);
    if (!manifest) return;
    if (manifest.writtenAtMs === this.lastWrittenAt) return;
    this.lastWrittenAt = manifest.writtenAtMs;

    this.peersByAddress.clear();
    this.peersByPubkey.clear();
    for (const p of manifest.peers) {
      this.peersByAddress.set(p.address, p);
      this.peersByPubkey.set(p.pubkeyHex, p);
    }
    this.allPeers = manifest.peers;
    this.onChange?.(this.allPeers);
  }
}

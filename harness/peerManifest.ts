/**
 * Atomic read/write of the coordinator's peer directory JSON file.
 *
 * The coordinator writes; applications read-only (poll or on demand).
 * Writes are atomic (tmp + rename) so apps never read a half-written
 * file.
 */

import type { PeerEntry } from './types.ts';

export interface PeerManifest {
  runId: string;
  writtenAtMs: number;
  peers: PeerEntry[];
}

export async function writePeerManifest(path: string, manifest: PeerManifest): Promise<void> {
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(manifest);
  await Deno.writeTextFile(tmp, body);
  await Deno.rename(tmp, path);
}

export async function readPeerManifest(path: string): Promise<PeerManifest | null> {
  try {
    const body = await Deno.readTextFile(path);
    return JSON.parse(body) as PeerManifest;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

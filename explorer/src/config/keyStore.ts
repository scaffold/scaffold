// Browser-side store of named secp256k1 private keys, persisted in
// localStorage. Each entry is identified by the hex digest of its private
// key bytes -- the same id surfaces in the URL `?key=<hex>` deep-link.

import { Hash } from "scaffold.io/util/Hash.ts";
import { bin2hex, hex2bin } from "scaffold.io/util/hex.ts";
import { secp } from "scaffold.io/util/secp.ts";
import {
  WELL_KNOWN_PRIVATE_KEY,
  WELL_KNOWN_PUBLIC_KEY,
} from "scaffold.io/genesis.ts";

const STORAGE_KEY = "scaffold-demo-keystore-v1";
const SELECTED_KEY_STORAGE = "scaffold-demo-selected-key-v1";

export interface KeyEntry {
  /** Hash hex of the private key bytes -- stable id across sessions. */
  id: string;
  label: string;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  /** True for keys the user cannot delete (e.g. well-known testnet). */
  builtIn: boolean;
}

interface StoredEntry {
  id: string;
  label: string;
  privateKeyHex: string;
}

interface StoredKeystore {
  entries: StoredEntry[];
}

const WELL_KNOWN_ID = hashOf(WELL_KNOWN_PRIVATE_KEY);

function hashOf(privateKey: Uint8Array): string {
  return Hash.digest(privateKey).toHex();
}

function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  return secp.getPublicKey(privateKey, true);
}

function loadStored(): StoredKeystore {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return { entries: [] };
    const parsed = JSON.parse(raw) as StoredKeystore;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch {
    return { entries: [] };
  }
}

function saveStored(store: StoredKeystore) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // noop -- storage unavailable
  }
}

function builtInEntry(): KeyEntry {
  return {
    id: WELL_KNOWN_ID,
    label: "Well-known (testnet)",
    privateKey: WELL_KNOWN_PRIVATE_KEY,
    publicKey: WELL_KNOWN_PUBLIC_KEY,
    builtIn: true,
  };
}

/** Read the full key list (built-ins first, then user keys in insertion order). */
export function loadKeys(): KeyEntry[] {
  const stored = loadStored();
  const userEntries: KeyEntry[] = [];
  for (const e of stored.entries) {
    if (e.id === WELL_KNOWN_ID) continue;
    let pk: Uint8Array;
    try {
      pk = hex2bin(e.privateKeyHex);
    } catch {
      continue;
    }
    if (pk.length !== 32) continue;
    userEntries.push({
      id: e.id,
      label: e.label,
      privateKey: pk,
      publicKey: publicKeyOf(pk),
      builtIn: false,
    });
  }
  return [builtInEntry(), ...userEntries];
}

function persistUserEntries(keys: KeyEntry[]) {
  const entries: StoredEntry[] = keys
    .filter((k) => !k.builtIn)
    .map((k) => ({
      id: k.id,
      label: k.label,
      privateKeyHex: bin2hex(k.privateKey),
    }));
  saveStored({ entries });
}

export function addRandomKey(
  existing: KeyEntry[],
  label?: string,
): { keys: KeyEntry[]; newId: string } {
  const pk = secp.utils.randomPrivateKey();
  const id = hashOf(pk);
  const userCount = existing.filter((k) => !k.builtIn).length;
  const entry: KeyEntry = {
    id,
    label: label?.trim() || `Key ${userCount + 1}`,
    privateKey: pk,
    publicKey: publicKeyOf(pk),
    builtIn: false,
  };
  const keys = [...existing, entry];
  persistUserEntries(keys);
  return { keys, newId: id };
}

export function importKey(
  existing: KeyEntry[],
  hex: string,
  label?: string,
): { keys: KeyEntry[]; newId: string } {
  const trimmed = hex.trim();
  let pk: Uint8Array;
  try {
    pk = hex2bin(trimmed);
  } catch {
    throw new Error("Private key must be hex-encoded");
  }
  if (pk.length !== 32) {
    throw new Error("Private key must be 32 bytes");
  }
  const id = hashOf(pk);
  if (existing.some((e) => e.id === id)) {
    return { keys: existing, newId: id };
  }
  const entry: KeyEntry = {
    id,
    label: label?.trim() || `Imported ${id.slice(0, 6)}`,
    privateKey: pk,
    publicKey: publicKeyOf(pk),
    builtIn: false,
  };
  const keys = [...existing, entry];
  persistUserEntries(keys);
  return { keys, newId: id };
}

export function renameKey(
  existing: KeyEntry[],
  id: string,
  label: string,
): KeyEntry[] {
  const next = existing.map((e) =>
    e.id === id && !e.builtIn ? { ...e, label: label.trim() || e.label } : e
  );
  persistUserEntries(next);
  return next;
}

export function deleteKey(existing: KeyEntry[], id: string): KeyEntry[] {
  const next = existing.filter((e) => !(e.id === id && !e.builtIn));
  persistUserEntries(next);
  return next;
}

export function findKey(keys: KeyEntry[], id: string | null): KeyEntry | null {
  if (!id) return null;
  return keys.find((k) => k.id === id) ?? null;
}

export function loadSelectedKeyId(): string | null {
  try {
    return globalThis.localStorage?.getItem(SELECTED_KEY_STORAGE) ?? null;
  } catch {
    return null;
  }
}

export function saveSelectedKeyId(id: string) {
  try {
    globalThis.localStorage?.setItem(SELECTED_KEY_STORAGE, id);
  } catch {
    // noop
  }
}

export const WELL_KNOWN_KEY_ID = WELL_KNOWN_ID;

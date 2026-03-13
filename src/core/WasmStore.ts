import { Hash, HashPrimitive } from '../util/Hash.ts';

/**
 * Simple in-memory store mapping contract hashes to their WASM binaries
 * (or TypeScript mock functions for testing).
 */
export class WasmStore {
  private readonly binaries = new Map<HashPrimitive, Uint8Array>();

  /** Store a WASM binary for a contract hash. */
  put(contractHash: Hash, binary: Uint8Array): void {
    this.binaries.set(contractHash.toPrimitive(), binary);
  }

  /** Retrieve the WASM binary for a contract hash. */
  get(contractHash: Hash): Uint8Array | undefined {
    return this.binaries.get(contractHash.toPrimitive());
  }

  /** Check if a contract binary is available. */
  has(contractHash: Hash): boolean {
    return this.binaries.has(contractHash.toPrimitive());
  }
}

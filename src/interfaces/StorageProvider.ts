import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';

export interface StorageProvider {
  set(namespace: number, key: Hash, value?: Uint8Array): void;
  get(namespace: number, key: Hash): MaybePromise<Uint8Array | undefined>;
  list(namespace: number): AsyncIterable<{ key: Hash; value: Uint8Array }>;
}

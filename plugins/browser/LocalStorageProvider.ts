import { Hash, HASH_SIZE } from '../../src/util/Hash.ts';
import { StorageProvider } from '../../src/interfaces/StorageProvider.ts';
import { bin2hex, hex2bin } from '../../src/util/hex.ts';

// TODO: Do these help/
// https://developer.mozilla.org/en-US/docs/Web/API/StorageEvent
// https://developer.mozilla.org/en-US/docs/Web/API/StorageManager

export class LocalStorageProvider implements StorageProvider {
  public set(namespace: number, key: Hash, value?: Uint8Array) {
    if (value !== undefined) {
      localStorage.setItem(
        key.toHex() + namespace.toString(36),
        bin2hex(value),
      );
    } else {
      localStorage.removeItem(key.toHex() + namespace.toString(36));
    }
  }

  public get(namespace: number, key: Hash) {
    const val = localStorage.getItem(key.toHex() + namespace.toString(36));
    return val !== null ? hex2bin(val) : undefined;
  }

  public async *list(namespace: number) {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      if (Number.parseInt(key.substring(HASH_SIZE * 2)) === namespace) {
        yield {
          key: Hash.fromHex(key.substring(0, HASH_SIZE * 2)),
          value: hex2bin(localStorage.getItem(key)!),
        };
      }
    }
  }
}

import Hash, { HASH_SIZE } from '~/sbl/util/Hash.ts';
import { StorageProvider } from '~/sbl/Config.ts';
import { bin2hex, hex2bin } from '~/sbl/pathUtils.ts';

export default class LocalStorageProvider implements StorageProvider {
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

  public close() {}
}

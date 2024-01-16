import Hash from '../src/util/Hash.ts';
import { StorageProvider } from '../src/Config.ts';

export default class NullStorageProvider implements StorageProvider {
  public set(_namespace: number, _key: Hash, _value?: Uint8Array) {}

  public get(_namespace: number, _key: Hash) {
    return undefined;
  }

  public async *list(_namespace: number) {}

  public close() {}
}

import Hash from '~/sbl/util/Hash.ts';
import { StorageProvider } from '~/sbl/Config.ts';

export default class NullStorageProvider implements StorageProvider {
  public set(_namespace: number, _key: Hash, _value?: Uint8Array) {}

  public get(_namespace: number, _key: Hash) {
    return undefined;
  }

  public async *list(_namespace: number) {}

  public close() {}
}

import Hash from '../src/util/Hash.ts';
import { StorageProvider } from '../src/Config.ts';

export default class DenoKvStorageProvider implements StorageProvider {
  private kv = Deno.openKv();

  public async set(namespace: number, key: Hash, value?: Uint8Array) {
    const kv = await this.kv;
    if (value !== undefined) {
      await kv.set([namespace, key.toBytes()], value);
    } else {
      await kv.delete([namespace, key.toBytes()]);
    }
  }

  public async get(namespace: number, key: Hash) {
    const kv = await this.kv;
    const entry = await kv.get<Uint8Array>([namespace, key.toBytes()]);
    return entry.value ?? undefined;
  }

  public async *list(namespace: number) {
    const kv = await this.kv;
    const entries = kv.list<Uint8Array>({ prefix: [namespace] });
    for await (const entry of entries) {
      yield {
        key: Hash.fromBytes(entry.key[1] as Uint8Array),
        value: entry.value,
      };
    }
  }

  public async close() {
    const kv = await this.kv;
    kv.close();
  }
}

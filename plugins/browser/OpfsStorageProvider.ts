import { Hash } from '../../src/util/Hash.ts';
import { StorageProvider } from '../../src/Config.ts';

export class OpfsStorageProvider implements StorageProvider {
  private root: Promise<FileSystemDirectoryHandle>;

  constructor() {
    this.root = navigator.storage.getDirectory();
  }

  public async set(namespace: number, key: Hash, value?: Uint8Array) {
    const nsHdl = await this.getNamespaceHandle(namespace);
    if (value !== undefined) {
      const fileHdl = await nsHdl.getFileHandle(key.toHex(), { create: true });
      const writable = await fileHdl.createWritable(); /* {mode:"exclusive"} */
      await writable.write(value);
    } else {
      await nsHdl.removeEntry(key.toHex());
    }
  }

  public async get(namespace: number, key: Hash) {
    const nsHdl = await this.getNamespaceHandle(namespace);
    try {
      const fileHdl = await nsHdl.getFileHandle(key.toHex(), { create: false });
      const file = await fileHdl.getFile();
      return await file.bytes();
    } catch {
      return undefined;
    }
  }

  public async *list(namespace: number) {
    const nsHdl = await this.getNamespaceHandle(namespace);
    for await (const [name, fileHdl] of nsHdl.entries()) {
      const file = await fileHdl.getFile();
      const value = await file.bytes();
      yield { key: Hash.fromHex(name), value };
    }
  }

  private async getNamespaceHandle(namespace: number) {
    const root = await this.root;
    return await root.getDirectoryHandle(namespace.toString(), { create: true });
  }
}

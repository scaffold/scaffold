import {
  Fs,
  FS_CAPABILITY_DIR_READ_ENTRY,
  FS_CAPABILITY_FILE_READ,
  FsCapabilityMask,
  FsDirEntry,
  FsDirNode,
  FsFileNode,
  FsNode,
} from './fsTypes.ts';

const IDENTITYFS_DEFAULT_CAP_MASK: FsCapabilityMask =
  FS_CAPABILITY_DIR_READ_ENTRY | FS_CAPABILITY_FILE_READ;

export default class IdentityFs implements Fs {
  constructor(private inodeSource: { nextInode: number }) {}

  public createDirNode(): FsDirNode {
    const fs = this;
    const inode = this.inodeSource.nextInode++;

    return {
      getFs() {
        return fs;
      },
      getInode() {
        return inode;
      },

      dispatch<T>(
        { dir }: { dir?: (dir: FsDirNode) => T },
        defaultHandler?: (node: FsNode) => T,
      ): T {
        return (dir || defaultHandler)!(this);
      },

      listEntries() {
        throw new Error(`IdentityFs does not support listEntries`);
      },

      // @ts-ignore: TS can't verify that undef -> undef, {} -> NE, and undef|{} -> undef|NE
      mutEntry<NodeExt extends FsNode>(
        key: Uint8Array,
        mutator: (
          entry: FsDirEntry | undefined,
        ) => { val: NodeExt; capMask: FsCapabilityMask } | undefined,
      ) {
        const node = fs.createIdentityNode(key);
        const entry = { key, val: node, capMask: IDENTITYFS_DEFAULT_CAP_MASK };
        // @ts-ignore: Says types have no intersection but they do
        if (mutator(entry) !== entry) {
          throw new Error(`IdentityFs does not support directory mutation`);
        }
        return node;
      },
    };
  }

  public createFileNode(): FsFileNode {
    throw new Error(`IdentityFs does not support file creation`);
  }

  private createIdentityNode(value: Uint8Array) {
    const fs = this;
    const inode = this.inodeSource.nextInode++;

    return {
      getFs() {
        return fs;
      },
      getInode() {
        return inode;
      },

      dispatch<T>(
        { file }: { file?: (file: FsFileNode) => T },
        defaultHandler?: (node: FsNode) => T,
      ): T {
        return (file || defaultHandler)!(this);
      },

      read(offset: number, dstBufs: Uint8Array[]) {
        const begin = offset;
        for (const buf of dstBufs) {
          const limit = Math.min(offset + buf.byteLength, value.byteLength);
          buf.set(value.subarray(offset, limit));
          offset = limit;
          if (offset === value.byteLength) {
            break;
          }
        }
        return offset - begin;
      },

      write(offset: number, bufs: Uint8Array[]) {
        throw new Error(`IdentityFs does not support file mutation`);
      },

      getSize() {
        return value.length;
      },

      resize(size: number) {
        throw new Error(`IdentityFs does not support file mutation`);
      },
    };
  }
}

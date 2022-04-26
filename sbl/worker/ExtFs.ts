import { bin2hex } from '../util/hex.ts';
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
import { WorkerChannelClient } from './WorkerChannel.ts';
import { WorkerComm } from './workerTypes.ts';

interface ExtFsNode extends FsDirNode, FsFileNode {}

const EXTFS_DEFAULT_CAP_MASK: FsCapabilityMask = FS_CAPABILITY_DIR_READ_ENTRY |
  FS_CAPABILITY_FILE_READ;

export default class ExtFs implements Fs {
  constructor(
    private inodeSource: { nextInode: number },
    private client: WorkerChannelClient<WorkerComm>,
  ) {}

  public createDirNode(): FsDirNode {
    return this.createNode();
  }

  public createFileNode(): FsFileNode {
    return this.createNode();
  }

  private createNode(): ExtFsNode {
    const fs = this;
    const inode = this.inodeSource.nextInode++;

    const files = new Map<string, FsNode>();

    return {
      getFs() {
        return fs;
      },
      getInode() {
        return inode;
      },

      dispatch<T>(
        {
          dir,
          file,
        }: { dir?: (dir: FsDirNode) => T; file?: (file: FsFileNode) => T },
        defaultHandler?: (node: FsNode) => T,
      ): T {
        if (dir && file) {
          throw new Error(`ExtFs entries are usable as directories and files`);
        }
        return (dir || file || defaultHandler)!(this);
      },

      // DIRECTORY METHODS

      listEntries() {
        throw new Error(`ExtFs does not support listEntries`);
      },
      // @ts-ignore: TS can't verify that undef -> undef, {} -> NE, and undef|{} -> undef|NE
      mutEntry<NodeExt extends FsNode>(
        key: Uint8Array,
        mutator: (
          entry: FsDirEntry | undefined,
        ) => { val: NodeExt; capMask: FsCapabilityMask } | undefined,
      ) {
        const hex = bin2hex(key);
        let node = files.get(hex);
        if (!node) {
          node = fs.createNode();
          files.set(hex, node);

          // Gotta copy this buffer because we're not blocking, so the underlying buffer could change
          const informKey = key.slice();
          fs.client.inform(
            'fsOpen',
            [inode, informKey, node.getInode()],
            [informKey.buffer],
          );
        }
        const entry = { key, val: node, capMask: EXTFS_DEFAULT_CAP_MASK };
        // @ts-ignore: Says types have no intersection but they do
        if (mutator(entry) !== entry) {
          throw new Error(`ExtFs does not support directory mutation`);
        }
        return node;
      },

      // FILE METHODS

      read(offset: number, dstBufs: Uint8Array[]) {
        return fs.client.dispatch('fsRead', [inode, offset, dstBufs]);
      },

      write(offset: number, bufs: Uint8Array[]) {
        throw new Error(`ExtFs does not support file mutation`);
      },

      getSize() {
        return fs.client.dispatch('fsGetSize', [inode]);
      },

      resize(size: number) {
        throw new Error(`ExtFs does not support file mutation`);
      },
    };
  }
}

export type FsCapabilityMask = number;
export const FS_CAPABILITY_DIR_LIST_ENTRIES: FsCapabilityMask = 1 << 0;
export const FS_CAPABILITY_DIR_READ_ENTRY: FsCapabilityMask = 1 << 1;
export const FS_CAPABILITY_DIR_ENTRY_CREATE: FsCapabilityMask = 1 << 2;
export const FS_CAPABILITY_DIR_ENTRY_REMOVE: FsCapabilityMask = 1 << 3;
export const FS_CAPABILITY_FILE_READ: FsCapabilityMask = 1 << 4;
export const FS_CAPABILITY_FILE_WRITE: FsCapabilityMask = 1 << 5;
export const FS_CAPABILITY_ALL: FsCapabilityMask = (1 << 6) - 1;

export interface FsNode {
  getFs(): Fs;
  getInode(): number;

  dispatch<T>(
    handlers: { dir?: (dir: FsDirNode) => T; file?: (file: FsFileNode) => T },
    defaultHandler: (node: FsNode) => T,
  ): T;
  dispatch<T>(handlers: {
    dir: (dir: FsDirNode) => T;
    file: (file: FsFileNode) => T;
  }): T;
}

export interface FsDirEntry {
  key: Uint8Array;
  val: FsNode;
  capMask: FsCapabilityMask;
}

export interface FsDirNode extends FsNode {
  listEntries(): FsDirEntry[];
  mutEntry(
    key: Uint8Array,
    mutator: (entry: FsDirEntry | undefined) => undefined,
  ): undefined;
  mutEntry<NodeExt extends FsNode>(
    key: Uint8Array,
    mutator: (entry: FsDirEntry | undefined) => {
      val: NodeExt;
      capMask: FsCapabilityMask;
    },
  ): NodeExt;
  mutEntry<NodeExt extends FsNode>(
    key: Uint8Array,
    mutator: (
      entry: FsDirEntry | undefined,
    ) => { val: NodeExt; capMask: FsCapabilityMask } | undefined,
  ): NodeExt | undefined;
}

export interface FsFileNode extends FsNode {
  read(offset: number, dstBufs: Uint8Array[]): number; // Extract dstBufs[*].buffer before sending to host
  write(offset: number, bufs: Uint8Array[]): number;
  getSize(): number;
  resize(size: number): void;
}

// export interface FsSymlinkNode extends FsNode {
//   follow(path: Uint8Array[]): Uint8Array[];
// }

export interface Fs {
  createDirNode(): FsDirNode;
  createFileNode(): FsFileNode;
  // createSymlinkNode(
  //   popDirCount: number,
  //   appendDirs: Uint8Array[],
  // ): FsSymlinkNode;
}

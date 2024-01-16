import { bin2hex } from '../util/hex.ts';
import {
  Fs,
  FsCapabilityMask,
  FsDirEntry,
  FsDirNode,
  FsFileNode,
  FsNode,
} from './fsTypes.ts';

export default class MemFs implements Fs {
  constructor(private inodeSource: { nextInode: number }) {}

  public createDirNode(): FsDirNode {
    const fs = this;
    const inode = this.inodeSource.nextInode++;

    const files = new Map<string, FsDirEntry>();

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
        return Array.from(files, ([_, val]) => val);
      },

      // @ts-ignore: TS can't verify that undef -> undef, {} -> NE, and undef|{} -> undef|NE
      mutEntry<NodeExt extends FsNode>(
        key: Uint8Array,
        mutator: (
          entry: FsDirEntry | undefined,
        ) => { val: NodeExt; capMask: FsCapabilityMask } | undefined,
      ) {
        const hex = bin2hex(key);
        const before = files.get(hex);
        const after = mutator(before);
        if (after !== before) {
          if (after) {
            files.set(hex, { ...after, key });
          } else {
            files.delete(hex);
          }
        }
        return after?.val;
      },
    };
  }

  public createFileNode(): FsFileNode {
    const fs = this;
    const inode = this.inodeSource.nextInode++;

    const chunks: Uint8Array[] = [];
    let fileSize = 0;

    // Fixed-size chunking stragegy:
    const CHUNK_SIZE_LOG2 = 16;
    const CHUNK_SIZE = 1 << CHUNK_SIZE_LOG2;
    const getChunkIndex = (offset: number) => offset >>> CHUNK_SIZE_LOG2;
    const getChunkBegin = (ci: number) => ci << CHUNK_SIZE_LOG2;

    // Exponential-size chunking stragegy:
    // TODO

    const getChunk = (ci: number) => {
      while (chunks.length <= ci) {
        const size = getChunkBegin(chunks.length + 1) -
          getChunkBegin(chunks.length);
        chunks.push(new Uint8Array(size));
      }
      return chunks[ci];
    };

    const pairBufs = (
      offset: number,
      limit: number,
      bufs: Uint8Array[],
      cb: (chunk: Uint8Array, buf: Uint8Array) => void,
    ) => {
      if (offset >= limit) {
        return offset;
      }

      for (let i = 0; i < bufs.length; i++) {
        let buf = bufs[i];

        while (buf.length) {
          const ci = getChunkIndex(offset);
          const begin = getChunkBegin(ci);
          const end = Math.min(getChunkBegin(ci + 1), limit);
          const size = Math.min(end - offset, buf.length);
          const co = offset - begin;
          cb(getChunk(ci).subarray(co, co + size), buf.subarray(0, size));
          offset += size;
          if (offset === limit) {
            return offset;
          }
          buf = buf.subarray(size);
        }
      }

      return offset;
    };

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
        const end = pairBufs(
          offset,
          fileSize,
          dstBufs,
          (chunk, buf) => buf.set(chunk),
        );
        return end - offset;
      },

      write(offset: number, bufs: Uint8Array[]) {
        const end = pairBufs(
          offset,
          Infinity,
          bufs,
          (chunk, buf) => chunk.set(buf),
        );
        fileSize = Math.max(fileSize, end);
        return end - offset;
      },

      getSize() {
        return fileSize;
      },

      resize(size: number) {
        const min = Math.min(size, fileSize);
        const max = Math.max(size, fileSize);
        pairBufs(
          min,
          max,
          [new Uint8Array(max - min)],
          (chunk, buf) => chunk.set(buf),
        );
        fileSize = size;
      },
    };
  }

  /*
  public createSymlinkNode(
    popDirCount: number,
    appendDirs: Uint8Array[],
  ): FsSymlinkNode {
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
        { symlink }: { symlink?: (symlink: FsSymlinkNode) => T },
        defaultHandler?: (node: FsNode) => T,
      ): T {
        return (symlink || defaultHandler)!(this);
      },

      follow(path: Uint8Array[]) {
        if (popDirCount === Infinity) {
          return appendDirs;
        } else {
          return path.slice(0, -popDirCount).concat(appendDirs);
        }
      },
    };
  }
  */
}

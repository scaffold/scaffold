import { assert } from '@std/assert/assert';
import { BytesTree } from './protocol/base.ts';
import { arrEquals, bin2str, str2bin } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import { BYTES_FALSE, BYTES_TRUE, TreeObj } from './BytesTreeHelper.ts';

export interface TreeNode {
  open(key: number | string | Uint8Array): TreeNode;
  annotate(desc: string, mimeType?: string): void;
  // exists(): MaybePromise<boolean>;
  size(): MaybePromise<number | undefined>;
  read(dst: Uint8Array, offset: number): MaybePromise<number | undefined>;

  getBool(): MaybePromise<boolean>;
  getInt(): MaybePromise<number>;
  getBigInt(): MaybePromise<bigint>;
  getFloat(): MaybePromise<number>;
  getString(): MaybePromise<string>;
  getHash(): MaybePromise<Hash>;
  getBytes(): MaybePromise<Uint8Array>;
}

export interface MutableTreeNode extends TreeNode {
  open(key: number | string | Uint8Array): MutableTreeNode;
  copyFrom(src: TreeNode): void;
  write(buf: Uint8Array, offset: number): void;
  delete(): void;

  set(tree: TreeObj): void;
  setBool(value: boolean): void;
  setInt(value: number): void;
  setBigInt(value: bigint): void;
  setFloat(value: number): void;
  setString(value: string): void;
  setHash(value: Hash): void;
  setBytes(value: Uint8Array): void;
}

export class BytesTreeNode implements TreeNode {
  constructor(private src?: BytesTree) {}

  open(key: number | string | Uint8Array): TreeNode {
    switch (typeof key) {
      case 'number':
        key = key.toString();
      /* falls through */
      case 'string':
        key = str2bin(key);
    }
    return new BytesTreeNode(this.src?.entries.find((x) => arrEquals(x.key, key))?.node);
  }

  annotate(desc: string, mimeType?: string) {
    console.log('Annotate', desc, mimeType);
  }

  // exists(): MaybePromise<boolean> {
  //   throw new Error('Method not implemented.');
  // }

  size() {
    if (this.src === undefined) {
      throw new Error('Cannot call size() on a missing BytesTree node!');
    }
    return this.src.value?.bytes.byteLength;
  }

  read(dst: Uint8Array, offset: number) {
    if (this.src === undefined) {
      throw new Error('Cannot call read() on a missing BytesTree node!');
    }

    if (this.src.value !== null) {
      dst.set(this.src.value.bytes.subarray(offset, offset + dst.byteLength));
    }

    return this.src.value?.bytes.byteLength;
  }

  getBool() {
    const bytes = this.getBytes();
    if (arrEquals(bytes, BYTES_FALSE)) return false;
    if (arrEquals(bytes, BYTES_TRUE)) return true;
    else throw new Error(`Invalid boolean bytes: ${bytes}`);
  }

  getInt() {
    return parseInt(this.getString());
  }

  getBigInt() {
    return BigInt(this.getString());
  }

  getFloat() {
    return parseFloat(this.getString());
  }

  getString() {
    return bin2str(this.getBytes());
  }

  getHash() {
    return Hash.fromBytes(this.getBytes());
  }

  getBytes() {
    assert(this.src !== undefined);
    assert(this.src.value !== null);
    return this.src.value.bytes;
  }
}

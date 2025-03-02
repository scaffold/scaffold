import { assert } from '@std/assert/assert';
import { DataTree } from './protocol/base.ts';
import { arrEquals, bin2str, str2bin } from './util/buffer.ts';
import { Hash } from './util/Hash.ts';
import { MaybePromise } from './util/MaybePromise.ts';
import {
  BYTES_FALSE,
  BYTES_TRUE,
  EMPTY_DATA_TREE,
  encodeDataTree,
  TreeObj,
} from './DataTreeHelper.ts';

export interface Annotation {
  mimeType?: string;
  description?: string;
  markdownDescription?: string;
}

export interface TreeNode {
  isMutable: boolean;

  open(key: number | string | Uint8Array): ImmutableTreeNode | MutableTreeNode;
  annotate(annotation: Annotation): TreeNode; // Returns self for chainability
  // exists(): MaybePromise<boolean>;
  size(): MaybePromise<number | undefined>; // Returns the total size
  read(dst: Uint8Array, offset: number): MaybePromise<number | undefined>;

  getBool(): MaybePromise<boolean>;
  getInt(): MaybePromise<number>;
  getBigInt(): MaybePromise<bigint>;
  getFloat(): MaybePromise<number>;
  getString(): MaybePromise<string>;
  getHash(): MaybePromise<Hash>;
  getBytes(): MaybePromise<Uint8Array>;
}

export interface ImmutableTreeNode extends TreeNode {
  isMutable: false;
}

export interface MutableTreeNode extends TreeNode {
  isMutable: true;

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

const keyToBin = (key: number | string | Uint8Array): Uint8Array => {
  switch (typeof key) {
    case 'number':
      key = key.toString();
    /* falls through */
    case 'string':
      key = str2bin(key);
  }
  return key;
};

export class DataTreeNode implements ImmutableTreeNode {
  readonly isMutable = false;

  constructor(private src?: DataTree) {}

  open(key: number | string | Uint8Array) {
    key = keyToBin(key);
    return new DataTreeNode(this.src?.entries.find((x) => arrEquals(x.key, key))?.node);
  }

  annotate(annotation: Annotation) {
    console.log('Annotate', annotation);
    return this;
  }

  // exists(): MaybePromise<boolean> {
  //   throw new Error('Method not implemented.');
  // }

  size() {
    if (this.src === undefined) {
      throw new Error('Cannot call size() on a missing DataTree node!');
    }
    return this.src.value?.bytes.byteLength;
  }

  read(dst: Uint8Array, offset: number) {
    if (this.src === undefined) {
      throw new Error('Cannot call read() on a missing DataTree node!');
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

export class MutableDataTreeNode implements MutableTreeNode {
  readonly isMutable = true;

  #value?: Uint8Array;
  #entries: { key: Uint8Array; node: MutableDataTreeNode }[];

  constructor(init: DataTree = EMPTY_DATA_TREE) {
    this.#value = init.value !== null ? init.value.bytes : undefined;
    this.#entries = init.entries.map((x) => ({
      key: x.key,
      node: new MutableDataTreeNode(x.node),
    }));
  }

  toDataTree(): DataTree {
    return {
      value: this.#value !== undefined ? { bytes: this.#value } : null,
      entries: this.#entries.map((x) => ({ key: x.key, node: x.node.toDataTree() })),
    };
  }

  open(key: number | string | Uint8Array): MutableTreeNode {
    key = keyToBin(key);
    for (const entry of this.#entries) {
      if (arrEquals(entry.key, key)) {
        return entry.node;
      }
    }

    const node = new MutableDataTreeNode();
    this.#entries.push({ key, node });
    return node;
  }

  copyFrom(src: TreeNode): void {
    throw new Error('Method not implemented.');
  }

  write(buf: Uint8Array, offset: number): void {
    const minLen = offset + buf.byteLength;
    if (this.#value === undefined) {
      this.#value = new Uint8Array(minLen);
    } else if (minLen > this.#value.byteLength) {
      if (minLen > this.#value.buffer.byteLength) {
        const newSize = Math.max((this.#value.buffer.byteLength * 3) >>> 1, minLen);
        const newArr = new Uint8Array(newSize);
        newArr.set(this.#value);
        newArr.set(buf, offset);
        this.#value = newArr;
      } else {
        this.#value = new Uint8Array(this.#value.buffer, 0, minLen);
        this.#value.set(buf, offset);
      }
    } else {
      this.#value.set(buf, offset);
    }
  }

  delete(): void {
    throw new Error('Method not implemented.');
  }

  set(obj: TreeObj): void {
    const tree = encodeDataTree(obj);
    this.#value = tree.value !== null ? tree.value.bytes : undefined;
    this.#entries = tree.entries.map((x) => ({
      key: x.key,
      node: new MutableDataTreeNode(x.node),
    }));
  }

  setBool(value: boolean): void {
    this.#value = value ? BYTES_TRUE : BYTES_FALSE;
  }

  setInt(value: number): void {
    this.setString(value.toString());
  }

  setBigInt(value: bigint): void {
    this.setString(value.toString());
  }

  setFloat(value: number): void {
    this.setString(value.toString());
  }

  setString(value: string): void {
    this.#value = str2bin(value);
  }

  setHash(value: Hash): void {
    this.#value = value.toBytes();
  }

  setBytes(value: Uint8Array): void {
    this.#value = value;
  }

  annotate(annotation: Annotation) {
    throw new Error('Method not implemented.');
    return this;
  }

  size(): MaybePromise<number | undefined> {
    throw new Error('Method not implemented.');
  }

  read(dst: Uint8Array, offset: number): MaybePromise<number | undefined> {
    throw new Error('Method not implemented.');
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
    assert(this.#value !== undefined);
    return this.#value;
  }
}

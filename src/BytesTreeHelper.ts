import { assert } from '@std/assert/assert';
import { BytesTree } from './protocol/base.ts';
import { arrEquals, bin2str, isAscii, str2bin } from './util/buffer.ts';
import { Hash, HashPrimitive } from './util/Hash.ts';
import { bin2hex, hex2bin } from './util/hex.ts';
import { ZERO_HASH } from './util/Hash.ts';

export const BTO_VALUE = Symbol('BytesTreeObjValue');

export type TreeObj =
  | { [BTO_VALUE]?: Uint8Array; [key: string]: TreeObj } & { [Key in `$${string}`]: never }
  | { '$hex': string }
  | Map<TreeObj, TreeObj>
  | Hash
  | Uint8Array
  | string
  | bigint
  | number
  | boolean
  | undefined;

export const BYTES_FALSE = str2bin('false');
export const BYTES_TRUE = str2bin('true');

export const encodeBytesTree = (obj: TreeObj): BytesTree => {
  switch (typeof obj) {
    case 'undefined':
      return { value: null, entries: [] };
    case 'boolean':
      return { value: { bytes: obj ? BYTES_TRUE : BYTES_FALSE }, entries: [] };
    case 'number':
      return { value: { bytes: str2bin(obj.toString()) }, entries: [] };
    case 'bigint':
      return { value: { bytes: str2bin(obj.toString()) }, entries: [] };
    case 'string':
      return { value: { bytes: str2bin(obj) }, entries: [] };
    case 'object':
      if (obj instanceof Uint8Array) {
        return { value: { bytes: obj }, entries: [] };
      } else if (obj instanceof Hash) {
        return { value: { bytes: obj.toBytes() }, entries: [] };
      } else if (obj instanceof Map) {
        return {
          value: null,
          entries: [...obj.entries()].map(([key, val]) => {
            const keyTree = encodeBytesTree(key);
            assert(keyTree.value !== null && keyTree.entries.length === 0);
            return {
              key: keyTree.value.bytes,
              node: encodeBytesTree(val),
            };
          }),
        };
      } else if ('$hex' in obj) {
        assert(Object.entries(obj).length === 1);
        return { value: { bytes: hex2bin(obj.$hex) }, entries: [] };
      } else {
        const value = obj[BTO_VALUE];
        return {
          value: value !== undefined ? { bytes: value } : null,
          entries: Object.entries(obj).map(([key, val]) => ({
            key: str2bin(key),
            node: encodeBytesTree(val),
          })),
        };
      }
    default:
      throw new Error(`Invalid TreeObj ${JSON.stringify(obj)}`);
  }
};

// This should only be used for debugging / presentation to the user.
// We shouldn't use this because bytes trees should be queried, not walked or inspected.
// Also it's lossy

export type BytesTreeObj = { [key: string]: BytesTreeObj } | string | undefined;

const maybeToStr = (bytes: Uint8Array) =>
  isAscii(bytes) ? bin2str(bytes) : { $hex: bin2hex(bytes) };

export const bytesTreeToJson = (tree: BytesTree): BytesTreeObj => {
  if (tree.entries.length === 0) {
    return tree.value !== null ? maybeToStr(tree.value.bytes) : undefined;
  } else {
    const obj: BytesTreeObj = Object.fromEntries(
      tree.entries.map((entry) => [bin2str(entry.key), bytesTreeToJson(entry.node)]),
    );
    if (tree.value !== null) {
      obj.$self = maybeToStr(tree.value.bytes);
    }
    return obj;
  }
};

export const areTreesEqual = (lhs: BytesTree, rhs: BytesTree): boolean => {
  if (lhs.entries.length !== rhs.entries.length) return false;

  if (lhs.value !== null) {
    if (rhs.value === null) return false;
    else if (!arrEquals(lhs.value.bytes, rhs.value.bytes)) return false;
  } else if (rhs.value !== null) return false;

  for (let i = 0; i < lhs.entries.length; i++) {
    const a = lhs.entries[i];
    const b = rhs.entries[i];
    if (!arrEquals(a.key, b.key)) return false;
    if (!areTreesEqual(a.node, b.node)) return false;
  }

  return true;
};

export const digestTree = (tree: BytesTree): Hash => {
  return Hash.digestParts(
    tree.value !== null ? tree.value.bytes : ZERO_HASH,
    ...tree.entries.flatMap((x) => [x.key, digestTree(x.node)]),
  );
};

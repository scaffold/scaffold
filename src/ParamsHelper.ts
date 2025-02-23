import { assert } from '@std/assert/assert';
import { bin2hex } from './util/hex.ts';
import { mapPut } from './util/map.ts';
import { error } from './util/functional.ts';

export interface Params {
  data: Uint8Array;
  lengths: number[];
}

// TODO: Create a more succinct data structure over the params

export interface ParamTree {
  key?: Uint8Array;
  value?: Uint8Array;
  children?: Map<string, ParamTree>;
}

export const decodeParams = (params: Params): ParamTree => {
  const root: ParamTree = {};
  const stack = [root];

  let offset = 0;
  for (const size of params.lengths) {
    if (size < 0) {
      // Value
      const limit = offset - size - 1;
      const top = stack.pop() ?? error(`Invalid params; too many value pops`);
      assert(top.value === undefined);
      top.value = params.data.subarray(offset, limit);
      offset = limit;
    } else if (size > 0) {
      // Key
      const limit = offset + size - 1;
      const key = params.data.subarray(offset, limit);
      const top = stack[stack.length - 1] ?? error(`Invalid params; pushing onto an empty stack`);
      top.children ??= new Map();
      stack.push(mapPut(top.children, bin2hex(key), () => ({ key })));
      offset = limit;
    } else {
      // Nil
      stack.pop();
    }
  }

  if (stack.length) {
    assert(offset <= params.data.byteLength);

    const top = stack.pop()!;
    assert(top.value === undefined);
    top.value = params.data.subarray(offset);
  } else {
    assert(offset === params.data.byteLength);
  }

  return root;
};

const getTotalSize = (tree: ParamTree): number => {
  let size = (tree.key?.byteLength ?? 0) + (tree.value?.byteLength ?? 0);
  if (tree.children !== undefined) {
    for (const entry of tree.children.values()) {
      size += getTotalSize(entry);
    }
  }
  return size;
};

export const encodeParams = (tree: ParamTree): Params => {
  const data = new Uint8Array(getTotalSize(tree));

  const lengths: number[] = [];
  let offset = 0;
  const walk = (tree: ParamTree) => {
    if (tree.key !== undefined) {
      lengths.push(tree.key.byteLength + 1);
      data.set(tree.key, offset);
      offset += tree.key.byteLength;
    }

    if (tree.children !== undefined) {
      for (const entry of tree.children.values()) {
        walk(entry);
      }
    }

    if (tree.value !== undefined) {
      lengths.push(-tree.value.byteLength - 1);
      data.set(tree.value, offset);
      offset += tree.value.byteLength;
    } else {
      lengths.push(0);
    }
  };
  walk(tree);

  assert(offset === data.byteLength);

  return { data, lengths };
};

import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';

// TODO(claude): Name this "Reader" or something else instead of "Node"?

export enum NodeType {
  Null = 0,
  Bool = 1,
  Number = 2,
  Bytes = 3,
  String = 4,
  Array = 5,
  Object = 6,
}

interface NullNode {
  type: NodeType.Null;
}
interface BoolNode {
  type: NodeType.Bool;
  value: boolean;
}
interface NumberNode {
  type: NodeType.Number;
  value: number;
}
interface BytesNode {
  type: NodeType.Bytes;
  value: Uint8Array;
}
interface StringNode {
  type: NodeType.String;
  value: string;
}
interface ArrayNode {
  type: NodeType.Array;
  length: number;
  at(index: number, descriptor: string): MaybePromise<Node>;
}
interface ObjectNode {
  type: NodeType.Object;
  keys: string[];
  at(key: string, descriptor: string): MaybePromise<Node>;
}
export type Node =
  | NullNode
  | BoolNode
  | NumberNode
  | BytesNode
  | StringNode
  | ArrayNode
  | ObjectNode;

export function createNode(value: unknown): Node {
  switch (typeof value) {
    case 'undefined':
      return { type: NodeType.Null };
    case 'boolean':
      return { type: NodeType.Bool, value };
    case 'number':
      return { type: NodeType.Number, value };
    case 'string':
      return { type: NodeType.String, value };
    case 'object':
      if (value === null) return { type: NodeType.Null };
      else if (value instanceof Uint8Array) return { type: NodeType.Bytes, value };
      else if (Array.isArray(value)) {
        return {
          type: NodeType.Array,
          length: value.length,
          at: (idx, _desc) => createNode(value[idx]),
        };
      } else {
        return {
          type: NodeType.Object,
          keys: Object.keys(value),
          at: (key, _desc) => createNode((value as Record<string, unknown>)[key]),
        };
      }
    default:
      throw new Error(`Unsupported type ${typeof value}`);
  }
}

export interface Query {
  contract: Hash;
  params: Uint8Array | ((descriptor: string) => MaybePromise<Node>);
}

class BinaryContractInputExample implements Query {
  contract = Hash.fromHex('');
  params: Uint8Array;

  constructor(params: { x: number; y: number }) {
    this.params = new Uint8Array(8);
    const dv = new DataView(this.params.buffer);
    dv.setInt32(0, params.x);
    dv.setInt32(4, params.y);
  }
}

class NodeContractInputExample implements Query {
  contract = Hash.fromHex('');
  params: (_descriptor: string) => Node;

  constructor(params: { x: number; y: number }) {
    this.params = (_descriptor: string) => createNode(params);
  }
}

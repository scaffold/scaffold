import { bin2str } from '../util/buffer.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { FsNode, FsNodeType, ScaffoldCliDeps } from './ScaffoldCLI.ts';

enum NodeType {
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
  at(index: number): MaybePromise<Node>;
}
interface ObjectNode {
  type: NodeType.Object;
  keys: string[];
  at(key: string): MaybePromise<Node>;
}
type Node = NullNode | BoolNode | NumberNode | BytesNode | StringNode | ArrayNode | ObjectNode;

export class CliBuilderHost {
  constructor(private deps: ScaffoldCliDeps) {}

  getRoot(path: string): Promise<Node> {
    return this.makeFromOpen(this.deps, path);
  }

  private async makeFromOpen(
    base: { open(name: string): Promise<FsNode | { type: FsNodeType.Missing }> },
    name: string,
  ): Promise<Node> {
    const node = await base.open(name);
    if (node.type === FsNodeType.File) {
      return { type: NodeType.Bytes, value: await node.read() };
    } else if (node.type === FsNodeType.Directory) {
      return {
        type: NodeType.Object,
        keys: (await node.list()).map((x) => x.name),
        at: (key) => this.makeFromOpen(node, key),
      };
    }

    const jsonNode = await base.open(name + '.json');
    if (jsonNode.type === FsNodeType.File) {
      const value = JSON.parse(bin2str(await jsonNode.read()));
      return this.makeFromValue(value);
    }

    throw new Error(`Cannot open ${name}`);
  }

  private makeFromValue(value: unknown): Node {
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
        else if (Array.isArray(value)) {
          return {
            type: NodeType.Array,
            length: value.length,
            at: (idx) => this.makeFromValue(value[idx]),
          };
        } else {
          return {
            type: NodeType.Object,
            keys: Object.keys(value),
            at: (key) => this.makeFromValue((value as Record<string, unknown>)[key]),
          };
        }
      default:
        throw new Error(`Invalid type ${typeof value}`);
    }
  }
}

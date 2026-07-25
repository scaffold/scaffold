interface Node {
  parent?: this;
  children: this[];
}

export class Module<NodeType extends Node> {
  collect(node: NodeType): NodeType[] {
    return [node, ...node.children.flatMap((child) => this.collect(child))];
  }
}

interface X extends Node {
  abc: number;
}

new Module<X>().collect({
  abc: 123,
  children: [{
    abc: 12334,
    children: [],
  }],
});

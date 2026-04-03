// Protocol spec: docs/protocol/output-data.md

import type { ValueDescriptor, WalkerHost } from './Contract.ts';

/** A node in the recorded field tree. */
export type FieldNode =
  | { kind: 'bytes'; key: string; value: Uint8Array; desc: ValueDescriptor }
  | { kind: 'string'; key: string; value: string; desc: ValueDescriptor }
  | { kind: 'number'; key: string; value: number; desc: ValueDescriptor }
  | { kind: 'bool'; key: string; value: boolean; desc: ValueDescriptor }
  | { kind: 'map'; key: string; children: FieldNode[] }
  | { kind: 'list'; key: string; count: number; children: FieldNode[] };

interface StackFrame {
  kind: 'map' | 'list';
  key: string;
  count: number; // only meaningful for lists
  children: FieldNode[];
}

/**
 * A WalkerHost that records all emitted values into a tree of FieldNode objects.
 *
 * Uses a stack-based approach: map/list starts push a new frame; ends pop it
 * and attach the completed node to the parent.
 */
export class RecordingWalkerHost implements WalkerHost {
  private readonly root: FieldNode[] = [];
  private readonly stack: StackFrame[] = [];

  private current(): FieldNode[] {
    return this.stack.length > 0 ? this.stack[this.stack.length - 1].children : this.root;
  }

  emitBytes(key: string, value: Uint8Array, desc: ValueDescriptor): void {
    this.current().push({ kind: 'bytes', key, value, desc });
  }

  emitString(key: string, value: string, desc: ValueDescriptor): void {
    this.current().push({ kind: 'string', key, value, desc });
  }

  emitNumber(key: string, value: number, desc: ValueDescriptor): void {
    this.current().push({ kind: 'number', key, value, desc });
  }

  emitBool(key: string, value: boolean, desc: ValueDescriptor): void {
    this.current().push({ kind: 'bool', key, value, desc });
  }

  emitMapStart(key: string): boolean {
    this.stack.push({ kind: 'map', key, count: 0, children: [] });
    return true;
  }

  emitMapEnd(): void {
    const frame = this.stack.pop()!;
    this.current().push({ kind: 'map', key: frame.key, children: frame.children });
  }

  emitListStart(key: string, count: number): boolean {
    this.stack.push({ kind: 'list', key, count, children: [] });
    return true;
  }

  emitListEnd(): void {
    const frame = this.stack.pop()!;
    this.current().push({
      kind: 'list',
      key: frame.key,
      count: frame.count,
      children: frame.children,
    });
  }

  /** Returns the top-level recorded nodes. */
  getTree(): FieldNode[] {
    return this.root;
  }
}

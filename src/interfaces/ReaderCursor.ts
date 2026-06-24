import type { Reader } from './Reader.ts';
import { type ValueDescriptor, ValueType } from '../contracts/Contract.ts';
import type { MaybePromise } from '../util/MaybePromise.ts';

/**
 * Imperative cursor over a query `Reader` tree, for TypeScript contracts that
 * build `verifier.params` / `output.data` from structured user input.
 *
 * `enter` / `exit` walk into nested objects; the typed readers fetch a named
 * leaf of the current node. This is the TS-side analogue of `makeBuildBridge`
 * (which adapts the same navigation to the WASM `scaffold_builder.*` imports),
 * so a contract's builder works against any `Reader`: a concrete value tree
 * (`createReader`, e.g. CLI file input) or a `RecordingReader` (the explorer's
 * field-discovery / form path).
 *
 * The descriptors passed here are ignored by value Readers but recorded by a
 * `RecordingReader`, so keep them rich -- they drive the generated UI schema.
 */
export class ReaderCursor {
  private readonly stack: Reader[] = [];
  private root: MaybePromise<Reader> | undefined;

  constructor(private readonly reader: (descriptor: string) => MaybePromise<Reader>) {}

  private async current(): Promise<Reader> {
    if (this.stack.length > 0) return this.stack[this.stack.length - 1];
    if (this.root === undefined) this.root = this.reader('');
    return await this.root;
  }

  /** Resolve the named child of the current node, or a Null reader if absent. */
  private async child(key: string, desc: ValueDescriptor): Promise<Reader> {
    const node = await this.current();
    if (node.type === ValueType.Object) return await node.at(key, JSON.stringify(desc));
    return { type: ValueType.Null };
  }

  async bytes(key: string, desc: ValueDescriptor): Promise<Uint8Array> {
    const node = await this.child(key, desc);
    return node.type === ValueType.Bytes ? node.value : new Uint8Array(0);
  }

  async string(key: string, desc: ValueDescriptor): Promise<string> {
    const node = await this.child(key, desc);
    return node.type === ValueType.String ? node.value : '';
  }

  async number(key: string, desc: ValueDescriptor): Promise<number> {
    const node = await this.child(key, desc);
    return node.type === ValueType.Number ? node.value : 0;
  }

  async bool(key: string, desc: ValueDescriptor): Promise<boolean> {
    const node = await this.child(key, desc);
    return node.type === ValueType.Bool ? node.value : false;
  }

  /** Descend into the named object child for subsequent reads. Pair with `exit`. */
  async enter(key: string, desc: ValueDescriptor): Promise<void> {
    this.stack.push(await this.child(key, desc));
  }

  /** Ascend out of the object entered by the matching `enter`. */
  exit(): void {
    this.stack.pop();
  }

  /** Report invalid user input. A query Reader is read-only, so this throws. */
  validationError(key: string, message: string): never {
    throw new Error(`${key}: ${message}`);
  }
}

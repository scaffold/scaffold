import { MaybePromise } from '../util/MaybePromise.ts';
import { ListSink, MapSink, SinkRoot, ValueSink } from './values.ts';

class CloningSink<KeyType extends string | number> implements ValueSink {
  constructor(private obj: { [key in KeyType]: unknown }, private key: KeyType) {}

  setUnit() {
    this.obj[this.key] = null;
  }
  setBool(value: boolean) {
    this.obj[this.key] = value;
  }
  setNumber(value: number) {
    this.obj[this.key] = value;
  }
  setString(value: string) {
    this.obj[this.key] = value;
  }
  setBytes(value: Uint8Array) {
    this.obj[this.key] = value;
  }
  setList(): ListSink {
    const arr = this.obj[this.key] = [];
    return { at: (idx, _desc) => new CloningSink<number>(arr, idx) };
  }
  setMap(): MapSink {
    const obj = this.obj[this.key] = {};
    return { at: (key, _desc) => new CloningSink<string>(obj, key) };
  }
}

export async function createSink(cb: (sink: SinkRoot) => MaybePromise<void>): Promise<unknown> {
  const obj: { x: unknown } = { x: undefined };
  await cb((_desc) => new CloningSink<string>(obj, 'x'));
  return obj.x;
}

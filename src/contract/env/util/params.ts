import { arrConcat, arrFromNumber, bin2str, str2bin } from '../../../util/buffer.ts';
import { assert } from '../../../util/functional.ts';

const LENGTH_BYTES = 4;

export function serializeParams(objs: unknown[]): Uint8Array {
  return arrConcat(...objs.flatMap((obj) => {
    const json = JSON.stringify(obj);
    assert(typeof json === 'string', `Params are not JSON-serializable: ${String(obj)}`);
    const body = str2bin(json);
    return [arrFromNumber(body.length, LENGTH_BYTES), body];
  }));
}

export function deserializeParams(params: Uint8Array): unknown[] {
  // TODO: Implement this more directly
  const reader = new ParamsReader({ params: (truncate: number) => params.subarray(0, truncate) });
  const values: unknown[] = [];
  while (reader.read(values.length) !== undefined) values.push(reader.read(values.length));
  return values;
}

export class ParamsReader {
  private values: unknown[] = [];
  private end = 0;

  constructor(private env: { params(truncate: number): Uint8Array }) {}

  read(idx: number): unknown {
    assert(Number.isInteger(idx) && idx >= 0, `Invalid params index: ${idx}`);

    while (this.values.length <= idx) {
      const header = this.env.params(this.end + LENGTH_BYTES);
      if (header.length === this.end) return undefined;
      if (header.length !== this.end + LENGTH_BYTES) throw new Error('Malformed params');

      const length = new DataView(header.buffer, header.byteOffset, header.byteLength)
        .getUint32(this.end, true);
      this.end += LENGTH_BYTES;

      const body = this.env.params(this.end + length).subarray(this.end);
      if (body.length !== length) throw new Error('Malformed params');
      this.end += length;

      this.values.push(JSON.parse(bin2str(body)));
    }

    return this.values[idx];
  }
}

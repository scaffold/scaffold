import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { createReader, Reader } from './Reader.ts';

export interface Query {
  contract: Hash;
  params: Uint8Array | ((descriptor: string) => MaybePromise<Reader>);
}

export interface Record extends Query {
  data: Uint8Array | ((descriptor: string) => MaybePromise<Reader>);
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

class ReaderContractInputExample implements Query {
  contract = Hash.fromHex('');
  params: (_descriptor: string) => Reader;

  constructor(params: { x: number; y: number }) {
    this.params = () => createReader(params);
  }
}

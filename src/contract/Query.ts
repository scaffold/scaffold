import { Hash } from '../util/Hash.ts';
import { MaybePromise } from '../util/MaybePromise.ts';
import { createReader, Reader } from './Reader.ts';

/** Lazily-built structured params, walked by the contract's `build_params` entry. */
export type Builder = (descriptor: string) => MaybePromise<Reader>;

export interface Query {
  contract: Hash;
  params: Uint8Array | Builder;
}

export interface Statement extends Query {
  data: Uint8Array | Builder;
}

export class BinaryContractInputExample implements Query {
  contract = Hash.digest('binary contract');
  params: Uint8Array;

  constructor(params: { x: number; y: number }) {
    this.params = new Uint8Array(8);
    const dv = new DataView(this.params.buffer);
    dv.setInt32(0, params.x);
    dv.setInt32(4, params.y);
  }
}

export class ReaderContractInputExample implements Query {
  contract = Hash.digest('reader contract');
  params: (_descriptor: string) => Reader;

  constructor(params: { x: number; y: number }) {
    this.params = () => createReader(params);
  }
}

/*
ctx.get(Fetch).fetch({
  ...new BinaryContractInputExample({ x: 1, y: 2 }),
  onResult: (result) => {
    console.log(result, bin2str(result!.body));
  },
});
*/

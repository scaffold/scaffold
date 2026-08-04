import { Hash } from '../util/Hash.ts';
import { createSource } from './createSource.ts';
import { SourceRoot } from './values.ts';

export interface Query {
  contract: Hash | string;
  params: Uint8Array | SourceRoot;
}

export interface Statement extends Query {
  data: Uint8Array | SourceRoot;
}

export class ObjectQuery implements Query {
  public params: SourceRoot;

  constructor(public contract: Hash, params: unknown) {
    this.params = () => createSource(params);
  }
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
  params: SourceRoot;

  constructor(params: { x: number; y: number }) {
    this.params = () => createSource(params);
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

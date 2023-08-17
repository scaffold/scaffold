import Context from './Context.ts';
import Hash, { HashPrimitive } from './util/Hash.ts';
import BlockService from './BlockService.ts';

export default class HashInversionService {
  private datas = new Map<HashPrimitive, Uint8Array>();

  constructor(private ctx: Context) {}

  public provide(data: Uint8Array) {
    this.datas.set(Hash.digest(data).toPrimitive(), data);
  }

  public invert(hash: Hash) {
    const data = this.datas.get(hash.toPrimitive());
    if (data) {
      return data;
    }

    const block = this.ctx.get(BlockService).get(hash);
    if (block) {
      return block.data;
    }
  }
}

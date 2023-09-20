import Context from '~/sbl/Context.ts';

const CACHE_SIZE = 1024;

export default class EntropyService {
  public bytes = new Uint8Array(CACHE_SIZE);
  public idx = CACHE_SIZE;

  constructor(private ctx: Context) {}

  public getByte() {
    if (this.idx === CACHE_SIZE) {
      this.bytes = this.ctx.config.entropyProvider.randomBytes(CACHE_SIZE);
      this.idx = 0;
    }
    return this.bytes[this.idx++];
  }
}

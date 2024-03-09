export class GolombCoder {
  public static computeM(p: number) {
    return Math.ceil(-Math.log(2 - p) / Math.log(1 - p));
  }

  private b: number;
  private t: number;
  constructor(private m: number) {
    this.b = Math.floor(Math.log2(m));
    this.t = (1 << (this.b + 1)) - m;
  }

  private encodeRun(n: number) {
    let out = 0;
    while (n >= this.m) {
      n -= this.m;
      out |= 1;
      out <<= 1;
    }

    let b = this.b;
    if (n >= this.t) {
      b++;
      n += this.t;
    }

    out <<= b;
    out |= n;

    return out;
  }
}

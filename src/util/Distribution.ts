export class Distribution {
  private n = 0;
  private s_1 = 0;
  private s_2 = 0;

  public addObservation(x: number) {
    this.n++;
    this.s_1 += x;
    this.s_2 += x * x;
  }

  public removeObservation(x: number) {
    this.n--;
    this.s_1 -= x;
    this.s_2 -= x * x;
  }

  public getMean() {
    return this.s_1 / this.n;
  }
  public getVariance() {
    const mean = this.getMean();
    return this.s_2 / this.n - mean * mean;
  }
}

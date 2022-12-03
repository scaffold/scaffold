export default class Counter<T> {
  private counts = new Map<T, number>();

  public inc(x: T) {
    this.counts.set(x, (this.counts.get(x) || 0) + 1);
  }

  public dec(x: T) {
    const c = this.counts.get(x)! - 1;
    if (c) {
      this.counts.set(x, c);
    } else {
      this.counts.delete(x);
    }
  }

  public test(x: T) {
    return this.counts.get(x) || 0;
  }

  public count() {
    return this.counts.size;
  }
}

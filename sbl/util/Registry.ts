import Hash from './Hash.ts';

export default abstract class Registry<V> {
  private map: Map<string, V> = new Map();

  public get(_: {
    hash: Hash;
    creator?: () => V;
    callback?: (v: V) => void;
  }) {}

  // protected get(hash: Hash): V | undefined {
  //   return this.map.get(hash.toHex());
  // }

  protected getOrCreate(
    hash: Hash,
    creator: () => V,
    mutator?: (v: V) => V,
  ) {
    const hex = hash.toHex();
    let val = this.map.get(hex);
    if (!val) {
      val = creator();
      this.map.set(hex, val);
    } else if (mutator) {
      val = mutator(val);
      this.map.set(hex, val);
    }
    return val;
  }
}

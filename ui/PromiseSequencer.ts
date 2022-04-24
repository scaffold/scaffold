import { getOrCreate } from '~/sbl/util/map.ts';

export default class PromiseSequencer {
  private map: Map<string, Promise<void>> = new Map();

  public run(key: string, func: () => void | Promise<void>) {
    const promise = getOrCreate(this.map, key, () => Promise.resolve()).then(
      func,
    ).then(() => {
      if (this.map.get(key) === promise) {
        this.map.delete(key);
      }
    });
    this.map.set(key, promise);
  }
}

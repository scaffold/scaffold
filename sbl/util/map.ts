export const getOrCreate = <K, V>(
  map: Map<K, V> | (K extends object ? WeakMap<K, V> : never),
  key: K,
  creator: () => V,
  mutator?: (v: V) => V,
) => {
  let val = map.get(key);
  if (!val) {
    val = creator();
    map.set(key, val);
  } else if (mutator) {
    val = mutator(val);
    map.set(key, val);
  }
  return val;
};

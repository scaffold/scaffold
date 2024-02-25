export interface MapSpec<K, V> {
  get(k: K): V | undefined;
  set(k: K, v: V): void;
  delete(k: K): boolean;
}

export const mapPut = <K, V>(
  map: MapSpec<K, V>,
  key: K,
  creator: () => V,
  mutator?: (v: V) => V,
): V => {
  let val = map.get(key);
  if (val === undefined) {
    val = creator();
    map.set(key, val);
  } else if (mutator !== undefined) {
    val = mutator(val);
    map.set(key, val);
  }
  return val;
};

export const mapPop = <K, V>(map: MapSpec<K, V>, key: K) => {
  const val = map.get(key);
  if (val !== undefined) {
    map.delete(key);
  }
  return val;
};

export const multimapPut = <K, V>(map: MapSpec<K, V[]>, key: K, val: V) => {
  mapPut(map, key, () => []).push(val);
};

export const multimapPop = <K, V>(map: MapSpec<K, V[]>, key: K, val: V) => {
  const arr = map.get(key);
  if (arr === undefined) {
    throw new Error(`Cannot pop - key does not exist: ${key}`);
  }
  const idx = arr.lastIndexOf(val);
  if (idx === -1) {
    throw new Error(`Cannot pop - value does not exist!`);
  }
  if (arr.length > 1) {
    arr.splice(idx, 1);
  } else {
    map.delete(key);
  }
};

export const multimapCall = <K, Args extends unknown[]>(
  map: MapSpec<K, ((...args: Args) => void)[]>,
  key: K,
  ...args: Args
) => {
  const arr = map.get(key);
  if (arr !== undefined) {
    for (const cb of arr) {
      cb(...args);
    }
  }
};

export const getOrCreate = mapPut;

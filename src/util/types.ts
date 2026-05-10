type MapDP<T, B, K extends keyof B> = T extends B ? DeepPartial<T, K>
  : T extends unknown[] ? MapDP<T[number], B, K>[]
  : T extends Map<infer Key, infer Val> ? Map<MapDP<Key, B, K>, MapDP<Val, B, K>>
  : T extends Set<infer Key> ? Set<MapDP<Key, B, K>>
  : T;

export type DeepPartial<BaseFact, Keys extends keyof BaseFact> = {
  [K in Keys]: MapDP<BaseFact[K], BaseFact, Keys>;
};

export type Primitive = object | symbol | string | number | bigint | boolean | undefined | null;

export const setPut = <T>(set: Set<T>, val: T) => {
  const put = !set.has(val);
  if (put) {
    set.add(val);
  }
  return put;
};

export const setsIntersect = <T>(a: Set<T>, b: Set<T>) => {
  if (a.size > b.size) {
    const t = a;
    a = b;
    b = t;
  }
  for (const x of a) {
    if (b.has(x)) {
      return true;
    }
  }
  return false;
};

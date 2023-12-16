// Sets of tuples of atomics


// x = ...
// y = ...

// abc = ...


// abc.frontierVote

// isValid = abc.in(abc.map(frontierVote.inv());

type Tuple<T, N extends number> = N extends N ? number extends N ? T[] : _TupleOf<T, N, []> : never;
type _TupleOf<T, N extends number, R extends unknown[]> = R['length'] extends N ? R : _TupleOf<T, N, [T, ...R]>;


class TupleSet<N extends number>{
  constructor(){}

  public in(x:TupleSet<N>): boolean{}

  public union(x:TupleSet<N>): TupleSet<N>{}
  public intersection(x:TupleSet<N>): TupleSet<N>{}
  public difference(x:TupleSet<N>): TupleSet<N>{}

  public inv(): TupleSet<N>{}
  public power(): TupleSet<N>{}

  public map<M extends number>(x:TupleSet<M>): TupleSet<N+M-2>{}
}

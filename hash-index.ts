import Hash from './sbl/util/Hash.ts';

interface Msg {
  name: string;
  hash: Hash;
  buckets: Msg[][];
}

const makeMsg = (name: string, hash: Hash, inputs: Msg[]) => {
  const buckets: Msg[][] = [];
  for (let i = 0; i <= 256; i++) {
    let ptrs: Msg[] = [];
    inputs = inputs.flatMap((j) => {
      if (j.hash.bit(i) === hash.bit(i)) {
        ptrs = ptrs.concat(j.buckets[i]);
        return [j];
      } else {
        ptrs.push(j);
        return j.buckets[i];
      }
    });
    buckets.push(ptrs.filter((v, i, a) => a.indexOf(v) === i));
  }

  return { name, hash, buckets };
};

const toBits = (hash: Hash) => {
  let res = '';
  for (let i = 0; i < 32; i++) {
    res += hash.bit(i) ? '1' : '0';
  }
  return res;
};

const names = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

let pool: Msg[] = [];
for (let i = 0; i < 1000; i++) {
  const inputs = pool.filter((i) => Math.random() < 0.2);
  const msg = makeMsg(names[i] || `n_${i}`, Hash.random(), inputs);

  console.log(
    msg.name,
    toBits(msg.hash),
    '<-',
    inputs.map((i) => i.name).join(', '),
  );
  msg.buckets.forEach((b, i) =>
    b.length && console.log(' ', `b_${i}`, b.map((i) => i.name).join(', '))
  );

  pool.push(msg);
  pool = pool.filter((i) => Math.random() < 0.95);
}

/*
inputs: [
  G = {hash: 011, buckets: [A, B, C]},
  H = {hash: 001, buckets: [D, E, F]},
]
hash: 000

A: 1xx, B: 00x, C: 010
D: 1xx, E: 01x, F: 000

{
  hash: 000,
  buckets: [
    [A, D],
    [G, E],
    [B, H],
    [F],
  ],
}
*/

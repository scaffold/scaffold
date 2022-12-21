const toBin = (a) => a.toString(2);

const putEpochs = (t, x) => {
  const a = [t];
  for (let i = 1; i <= 1024; i <<= 1) {
    t++;
    t += (x - t) % i;
    a.push(t);
  }
  return a;
};

const getEpochs = (t, x) => {
  const a = [t];
  for (let i = 1; i <= 1024; i <<= 1) {
    t--;
    t -= (x - t) % i;
    a.push(t);
  }
  return a;
};

const a = 1;
const b = 200;
const x = 0b11001010;

console.log(toBin(x));
console.log(putEpochs(a, x));
console.log(putEpochs(a, x).map(toBin));
console.log(getEpochs(b, x));
console.log(getEpochs(b, x).map(toBin));

// Is this any better than as simple merkle tree

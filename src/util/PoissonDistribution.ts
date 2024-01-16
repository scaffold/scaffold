export default class PoissonDistribution {
  public static sample(lambda: number) {
    if (lambda > 100) {
      console.warn(
        `PoissonDistribution called with lambda=${lambda}; will probably iterate a lot`,
      );
    }

    // From https://en.wikipedia.org/wiki/Poisson_distribution#Random_variate_generation
    // With some modifications (remove `l` variable, transform to log space)
    let k = -1;
    let p = lambda;
    do {
      k++;
      p += Math.log(Math.random());
    } while (p > 0);
    return k;
  }
}

// Also can try: import poisson from 'https://cdn.jsdelivr.net/gh/stdlib-js/random-base-poisson@deno/mod.js';

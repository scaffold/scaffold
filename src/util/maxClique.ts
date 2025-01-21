import { assert } from '@std/assert/assert';

export const maxClique = <T extends { weight: number }>(
  arr: T[],
  isConnected: (a: T, b: T) => boolean,
) => {
  let bestClique: T[] = [];
  let bestWeight = -Infinity;

  const branch = (clique: T[], cliqueWeight: number, candidates: T[], candidatesWeight: number) => {
    if (candidates.length === 0) {
      assert(candidatesWeight === 0);
      if (cliqueWeight > bestWeight) {
        bestClique = [...clique];
        bestWeight = cliqueWeight;
      }
      return;
    }

    const test = candidates.pop()!;
    candidatesWeight -= test.weight;

    // First try with
    if (clique.every((x) => isConnected(x, test))) {
      clique.push(test);
      branch(clique, cliqueWeight + test.weight, candidates, candidatesWeight);
      clique.pop();
    }

    // Then try without
    if (cliqueWeight + candidatesWeight > bestWeight) {
      branch(clique, cliqueWeight, candidates, candidatesWeight);
    }

    candidates.push(test);
  };

  branch(
    [],
    0,
    arr.toSorted((a, b) => a.weight - b.weight), // Sort in ascending order
    arr.reduce((acc, cur) => acc + cur.weight, 0),
  );

  return { clique: bestClique, weight: bestWeight };
};

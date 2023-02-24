import Context from './Context.ts';

export default class RelationMonitor {
  private monitors: {
    name: string;
    lhsGenerator: () => Iterable<unknown>;
    rhsGenerator: () => Iterable<unknown>;
  }[] = [];

  constructor(private ctx: Context) {
    const itvl = setInterval(() => this.check(), 1000);
    ctx.onDestruct(() => clearInterval(itvl));
  }

  public monitor<T>(
    name: string,
    lhsGenerator: () => Iterable<T>,
    rhsGenerator: () => Iterable<T>,
  ) {
    this.monitors.push({ name, lhsGenerator, rhsGenerator });
  }

  private check() {
    this.monitors.forEach(({ name, lhsGenerator, rhsGenerator }) => {
      const lhs = new Set(lhsGenerator());
      const rhs = new Set(rhsGenerator());
      lhs.forEach((x) => {
        if (!rhs.has(x)) {
          throw new Error(
            `Monitor ${name} failed! Lhs has ${x} but rhs does not!`,
          );
        }
      });
      rhs.forEach((x) => {
        if (!lhs.has(x)) {
          throw new Error(
            `Monitor ${name} failed! Rhs has ${x} but lhs does not!`,
          );
        }
      });
    });
  }
}

import Context from './Context.ts';
import PoissonDistribution from '~/sbl/util/PoissonDistribution.ts';

export default class ClockService {
  private timeouts = new Set<number>();
  private intervals = new Set<number>();

  constructor(private ctx: Context) {
    ctx.onDestruct(() => {
      for (const timeout of this.timeouts) {
        ctx.config.timeProvider.clearTimeout(timeout);
      }

      for (const interval of this.intervals) {
        ctx.config.timeProvider.clearInterval(interval);
      }
    });
  }

  public setTimeout(func: () => void, wait: number) {
    const timeout = this.ctx.config.timeProvider.setTimeout(() => {
      func();
      this.timeouts.delete(timeout);
    }, wait);
    this.timeouts.add(timeout);
  }

  // TODO: Make this a little more efficient & less predictable
  public setPoissonInterval(func: () => void, wait: number) {
    const resolution = 0.25;
    wait *= resolution;

    const interval = this.ctx.config.timeProvider.setInterval(() => {
      const count = PoissonDistribution.sample(resolution);
      for (let i = 0; i < count; i++) {
        func();
      }
    }, wait);
    this.intervals.add(interval);
  }
}

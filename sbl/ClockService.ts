import Context from './Context.ts';

export default class ClockService {
  private timeouts = new Set<number>();

  constructor(private ctx: Context) {
    ctx.onDestruct(() =>
      this.timeouts.forEach((timeout) =>
        ctx.config.timeProvider.clearTimeout(timeout)
      )
    );
  }

  public setTimeout(func: () => void, wait: number) {
    const timeout = this.ctx.config.timeProvider.setTimeout(() => {
      func();
      this.timeouts.delete(timeout);
    }, wait);
    this.timeouts.add(timeout);
  }
}

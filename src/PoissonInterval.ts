import { Timeout } from './Config.ts';
import { Context } from './Context.ts';

export class PoissonInterval {
  private hdl?: Timeout;

  constructor(private ctx: Context, private func: () => void, private itvlMs: number) {
    ctx.onDestruct(() => {
      if (this.hdl !== undefined) {
        this.ctx.config.timeProvider.clearTimeout(this.hdl);
      }
    });
  }

  setRate(itvlMs: number) {
    this.itvlMs = itvlMs;
    if (this.hdl !== undefined) {
      this.ctx.config.timeProvider.clearTimeout(this.hdl);
    }
    this.enqueueNextEvent();
  }

  private enqueueNextEvent() {
    if (this.itvlMs === Infinity) {
      return;
    }

    const wait = -Math.log(this.ctx.config.entropyProvider.randomNumber()) * this.itvlMs;

    this.hdl = this.ctx.config.timeProvider.setTimeout(() => {
      this.hdl = undefined;
      this.func();
      this.enqueueNextEvent();
    }, wait);
  }
}

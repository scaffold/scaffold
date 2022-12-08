import Hash from './util/Hash.ts';
import Context from './Context.ts';
import { GeneratorRegistry, IncentiveRegistry } from './registries.ts';
import WorkPicker from './WorkPicker.ts';

export default class WorkLoop {
  private running: Hash[] = [];

  constructor(private ctx: Context) {
    const itv = setInterval(() => this.tick(), 100);
    this.ctx.onDestruct(() => clearInterval(itv));
  }

  private tick() {
    const launch = this.ctx.get(WorkPicker).pick(this.running);
    if (launch) {
      this.running.push(launch.key);
      // TODO: Actually launch
    }
  }
}

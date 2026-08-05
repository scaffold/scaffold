import { Context } from '../../Context.ts';

import { AtomicsWorkerTransport } from './AtomicsWorkerTransport.ts';
import { InProcessTransport } from './InProcessTransport.ts';
import { JspiTransport } from './JspiTransport.ts';
import { WasmConfig } from './WasmConfig.ts';
import { WasmTransport } from './WasmTransport.ts';

export class WasmRuntime {
  private active?: WasmTransport;

  constructor(private ctx: Context) {}

  transport(): WasmTransport {
    return this.active ??= this.select();
  }

  private select(): WasmTransport {
    const config = this.ctx.get(WasmConfig);
    switch (config.transport) {
      case 'inprocess':
        return new InProcessTransport();
      case 'jspi':
        return new JspiTransport();
      case 'worker':
        return new AtomicsWorkerTransport(config);
      case 'auto':
        // Worker first: the only killable transport, and the browser target.
        return AtomicsWorkerTransport.isSupported()
          ? new AtomicsWorkerTransport(config)
          : JspiTransport.isSupported()
          ? new JspiTransport()
          : new InProcessTransport();
    }
  }

  async [Symbol.asyncDispose]() {
    await this.active?.close();
  }
}

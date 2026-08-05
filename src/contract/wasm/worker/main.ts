/// <reference lib="deno.worker" />

// The WASM worker entry. One exec at a time; the pool serializes.

import { error } from '../../../util/functional.ts';
import { InProcessTransport } from '../InProcessTransport.ts';
import { MainToWorker, WorkerToMain } from '../WorkerChannel.ts';
import { Channel, tablesFromDecls } from './session.ts';

let channel: Channel | undefined;

const post = (msg: WorkerToMain) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      channel = {
        sig: new Int32Array(msg.sigBuf),
        staging: new Uint8Array(msg.stagingBuf),
        post,
      };
      break;
    case 'exec': {
      try {
        const tables = tablesFromDecls(msg.decls, channel ?? error('exec before init'));
        const result = await new InProcessTransport().invoke(msg.module, msg.entry, tables, {
          arg: msg.arg,
        });
        post({ type: 'done', result });
      } catch (e) {
        post({ type: 'crash', message: e instanceof Error ? e.message : String(e) });
      }
      break;
    }
    case 'exit':
      self.close();
      break;
  }
};

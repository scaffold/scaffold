// Protocol spec: docs/protocol/wasm-abi.md
//
// Worker entrypoint for the WASM contract ABI. Owns a single `WasmSession`
// at a time: each AtomicsWorkerTransport call sends instantiate + call,
// then a fresh worker (or recycled one) handles the next job. The pool
// (see `WasmWorkerPool`) decides when to terminate.

import { WasmCrashError, WasmRejectError, WasmWorkerChannelClient } from './WasmWorkerChannel.ts';
import type { WasmDoneMsg, WasmJobSpec } from './wasmWorkerTypes.ts';
import { WasmSession } from './wasmInstance.ts';

let client: WasmWorkerChannelClient | undefined;
let session: WasmSession | undefined;
let chain: Promise<void> = Promise.resolve();

function postTerminal(
  msg: WasmDoneMsg | { type: 'reject'; reason: string } | { type: 'crash'; message: string },
): void {
  (self as unknown as { postMessage(m: unknown): void }).postMessage(msg);
}

async function handleMessage(msg: WasmJobSpec): Promise<void> {
  try {
    switch (msg.type) {
      case 'init':
        client = new WasmWorkerChannelClient(
          self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void },
          msg.sigBuf,
          msg.stagingBuf,
        );
        return;

      case 'instantiate':
        if (!client) throw new Error('worker not initialised');
        session = new WasmSession(client);
        await session.instantiate(msg);
        return;

      case 'call': {
        if (!session) throw new Error('no session active');
        try {
          const result = session.call(msg);
          postTerminal({ type: 'done', result });
        } catch (err) {
          if (err instanceof WasmRejectError) {
            postTerminal({ type: 'reject', reason: err.message });
          } else if (err instanceof WasmCrashError) {
            postTerminal({ type: 'crash', message: err.message });
          } else if (err instanceof WebAssembly.RuntimeError) {
            // Trap with no scaffold-tagged reason: generic crash.
            postTerminal({ type: 'crash', message: err.message });
          } else if (err instanceof Error) {
            postTerminal({ type: 'crash', message: err.message });
          } else {
            postTerminal({ type: 'crash', message: String(err) });
          }
        } finally {
          session = undefined;
        }
        return;
      }

      case 'exit':
        (self as unknown as { close(): void }).close();
        return;

      default:
        msg satisfies never;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postTerminal({ type: 'crash', message });
  }
}

self.onmessage = (ev: MessageEvent<WasmJobSpec>) => {
  // Serialise message handling: `instantiate` is async, and we must not let
  // `call` race ahead of it. Chain everything through one Promise.
  chain = chain.then(() => handleMessage(ev.data));
};

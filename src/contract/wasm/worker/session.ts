// Worker-side import reconstruction: each declaration becomes a HostImport
// whose call round-trips to the main thread (or fire-and-forgets for pure
// void sinks). From here the standard in-process lowering runs unchanged --
// the Atomics round-trip is synchronous from this side, so nothing ever
// suspends.

import { error } from '../../../util/functional.ts';
import { HostImports } from '../WasmTransport.ts';
import {
  decodeReply,
  FLAG_THROW,
  FLAG_WAIT,
  ImportDecl,
  roundTrips,
  SIG_FLAG,
  SIG_LEN,
  WorkerToMain,
} from '../WorkerChannel.ts';

export interface Channel {
  sig: Int32Array;
  staging: Uint8Array;
  post(msg: WorkerToMain): void;
}

function callMain(channel: Channel, msg: WorkerToMain): Uint8Array {
  Atomics.store(channel.sig, SIG_FLAG, FLAG_WAIT);
  channel.post(msg);
  Atomics.wait(channel.sig, SIG_FLAG, FLAG_WAIT);
  const flag = Atomics.load(channel.sig, SIG_FLAG);
  const len = Atomics.load(channel.sig, SIG_LEN);
  const payload = channel.staging.slice(0, len);
  if (flag === FLAG_THROW) error(new TextDecoder().decode(payload));
  return payload;
}

export function tablesFromDecls(
  decls: ImportDecl[],
  channel: Channel,
): Record<string, HostImports> {
  const tables: Record<string, HostImports> = {};
  for (const decl of decls) {
    (tables[decl.namespace] ??= {})[decl.name] = {
      params: decl.params,
      result: decl.result,
      blocking: false,
      call: (...args: unknown[]) => {
        if (!roundTrips(decl)) {
          channel.post({ type: 'inform', namespace: decl.namespace, name: decl.name, args });
          return undefined;
        }
        const payload = callMain(channel, {
          type: 'call',
          namespace: decl.namespace,
          name: decl.name,
          args,
        });
        return decodeReply(decl.result, payload);
      },
    };
  }
  return tables;
}

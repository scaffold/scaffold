import Hash from '~/sbl/util/Hash.ts';
import Context from '../sbl/Context.ts';
import {
  ConnectionProvider,
  ProtocolProvider,
} from '../sbl/NetworkProvider.ts';
import { TimeProvider } from '../sbl/Config.ts';

const servers: Map<
  string,
  { connect: (send: (data: Uint8Array) => void) => (data: Uint8Array) => void }
> = new Map();

class TimerSet {
  private timeouts = new Set<number>();

  constructor(private timeProvider: TimeProvider) {}

  public set(cb: () => void, delay: number) {
    const idx = this.timeProvider.setTimeout(() => {
      this.timeouts.delete(idx);
      cb();
    }, delay);
    this.timeouts.add(idx);
  }

  public clearAll() {
    this.timeouts.forEach((idx) => this.timeProvider.clearTimeout(idx));
  }
}

export const makeMockNetworkProvider = (opts: {
  connectLatencyMs: number;
  sendReliableLatencyMs: number;
  sendFastLatencyMs: number;
  sendFastDropRatio: number;
}): ProtocolProvider => ({
  createClient: (
    _onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
    ctx: Context,
  ) => {
    let send: (data: Uint8Array) => void;
    const onClose: (() => void)[] = [];
    const timerSet = new TimerSet(ctx.config.timeProvider);

    return {
      tryConnect: (spec: string) => {
        const server = servers.get(spec);
        if (server === undefined) {
          console.error(`Tried connecting to a non-existent spec ${spec}`);
          return;
        }

        timerSet.set(() =>
          onNewConn({
            sendReliable: (data: Uint8Array) =>
              timerSet.set(
                () => send(data),
                (Math.random() + 0.5) * opts.sendReliableLatencyMs,
              ),
            sendFast: (data: Uint8Array) =>
              Math.random() > opts.sendFastDropRatio &&
              timerSet.set(
                () => send(data),
                (Math.random() + 0.5) * opts.sendFastLatencyMs,
              ),
            onRecv: (handler: (data: Uint8Array) => void) => {
              send = server.connect(handler);
            },
            close: () => {
              onClose.forEach((cb) => cb());
              timerSet.clearAll();
            },
            onClose: (handler: () => void) => onClose.push(handler),
          }), (Math.random() + 0.5) * opts.connectLatencyMs);
      },
    };
  },

  createServer: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
    ctx: Context,
  ) => {
    const onClose: (() => void)[] = [];
    const timerSet = new TimerSet(ctx.config.timeProvider);

    const addr = Hash.random().toHex();
    servers.set(addr, {
      connect: (send: (data: Uint8Array) => void) => {
        let recvHandler: (data: Uint8Array) => void;
        onNewConn({
          sendReliable: (data: Uint8Array) =>
            // console.log(
            //   Packet.decode(data.subarray(64)),
            timerSet.set(
              () => send(data),
              (Math.random() + 0.5) * opts.sendReliableLatencyMs,
            ),
          // ),
          sendFast: (data: Uint8Array) =>
            Math.random() > opts.sendFastDropRatio &&
            timerSet.set(
              () => send(data),
              (Math.random() + 0.5) * opts.sendFastLatencyMs,
            ),
          onRecv: (handler: (data: Uint8Array) => void) => {
            recvHandler = handler;
          },
          close: () => {
            onClose.forEach((cb) => cb());
            // console.log('CLOSE', timeouts);
            timerSet.clearAll();
          },
          onClose: (handler: () => void) => onClose.push(handler),
        });
        return recvHandler!;
      },
    });
    onListen(addr);
  },
});

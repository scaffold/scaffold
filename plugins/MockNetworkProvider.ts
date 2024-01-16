import NetworkProvider, { ConnectionProvider } from '../src/NetworkProvider.ts';
import Hash from '../src/util/Hash.ts';
import { TimeProvider } from '../src/Config.ts';

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

export default class MockNetworkProvider implements NetworkProvider {
  public dialsTo = 'mock';
  public listensTo = 'mock';

  private servers = new Map<
    string,
    {
      connect: (send: (data: Uint8Array) => void) => (data: Uint8Array) => void;
    }
  >();

  constructor(
    private opts: {
      timeProvider: TimeProvider;
      connectLatencyMs: number;
      sendReliableLatencyMs: number;
      sendFastLatencyMs: number;
      sendFastDropRatio: number;
    },
  ) {}

  public createServer(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    const onClose: (() => void)[] = [];
    const timerSet = new TimerSet(this.opts.timeProvider);

    const addr = Hash.random().toHex();
    this.servers.set(addr, {
      connect: (send: (data: Uint8Array) => void) => {
        let recvHandler: (data: Uint8Array) => void;
        onNewConn({
          sendReliable: (data: Uint8Array) =>
            // console.log(
            //   Packet.decode(data.subarray(64)),
            timerSet.set(
              () => send(data),
              (Math.random() + 0.5) * this.opts.sendReliableLatencyMs,
            ),
          // ),
          sendFast: (data: Uint8Array) =>
            Math.random() > this.opts.sendFastDropRatio &&
            timerSet.set(
              () => send(data),
              (Math.random() + 0.5) * this.opts.sendFastLatencyMs,
            ),
          onRecv: (handler: (data: Uint8Array) => void) => {
            recvHandler = handler;
          },
          shutdown: () => {
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
  }

  public createClient(
    _onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    let send: (data: Uint8Array) => void;
    const onClose: (() => void)[] = [];
    const timerSet = new TimerSet(this.opts.timeProvider);

    return {
      tryConnect: (spec: string) => {
        const server = this.servers.get(spec);
        if (server === undefined) {
          console.error(`Tried connecting to a non-existent spec ${spec}`);
          return;
        }

        timerSet.set(() =>
          onNewConn({
            sendReliable: (data: Uint8Array) =>
              timerSet.set(
                () => send(data),
                (Math.random() + 0.5) * this.opts.sendReliableLatencyMs,
              ),
            sendFast: (data: Uint8Array) =>
              Math.random() > this.opts.sendFastDropRatio &&
              timerSet.set(
                () => send(data),
                (Math.random() + 0.5) * this.opts.sendFastLatencyMs,
              ),
            onRecv: (handler: (data: Uint8Array) => void) => {
              send = server.connect(handler);
            },
            shutdown: () => {
              onClose.forEach((cb) => cb());
              timerSet.clearAll();
            },
            onClose: (handler: () => void) => onClose.push(handler),
          }), (Math.random() + 0.5) * this.opts.connectLatencyMs);
      },
    };
  }
}

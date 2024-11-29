import {
  ConnectionProvider,
  NetworkProvider,
  SignalingDriver,
} from '../src/NetworkProvider.ts';
import { Hash } from '../src/util/Hash.ts';
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

interface Server extends ConnectionProvider {
  recvHandler?(data: Uint8Array): void;
  closeHandler?(): void;
}

export class MockNetworkProvider implements NetworkProvider {
  public providesProtocol = 'mock';

  private servers = new Map<string, Server>();

  constructor(
    private opts: {
      timeProvider: TimeProvider;
      connectLatencyMs: number;
      sendReliableLatencyMs: number;
      sendFastLatencyMs: number;
      sendFastDropRatio: number;
    },
  ) {}

  public createInstance(driver: SignalingDriver) {
    const timerSet = new TimerSet(this.opts.timeProvider);

    let remote: Server | undefined;

    const addr = Hash.random().toHex();
    const server: Server = {
      sendReliable: (data: Uint8Array) =>
        timerSet.set(
          () => remote!.recvHandler!(data),
          (Math.random() + 0.5) * this.opts.sendReliableLatencyMs,
        ),
      sendFast: (data: Uint8Array) =>
        Math.random() > this.opts.sendFastDropRatio &&
        timerSet.set(
          () => remote!.recvHandler!(data),
          (Math.random() + 0.5) * this.opts.sendFastLatencyMs,
        ),
      onRecv: (handler: (data: Uint8Array) => void) => {
        if (server.onRecv !== undefined) {
          throw new Error(`Cannot call onRecv multiple times!`);
        }
        server.recvHandler = handler;
      },
      shutdown: () => {
        server.closeHandler!();
        // console.log('CLOSE', timeouts);
        timerSet.clearAll();
      },
      onClose: (handler: () => void) => {
        if (server.closeHandler !== undefined) {
          throw new Error(`Cannot call onClose multiple times!`);
        }
        server.closeHandler = handler;
      },
    };

    this.servers.set(addr, server);
    driver.sendSignal(addr);

    return {
      recvSignal: (signal: string) => {
        if (remote !== undefined) {
          throw new Error(`Extra signal ${signal}`);
        }

        remote = this.servers.get(signal);
        if (remote === undefined) {
          throw new Error(`Unable to connect to ${signal}`);
        }

        timerSet.set(
          () => driver.createConnection(server),
          (Math.random() + 0.5) * this.opts.connectLatencyMs,
        );
      },
    };
  }
}

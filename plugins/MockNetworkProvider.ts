import { ConnectionProvider, NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';
import { Hash } from '../src/util/Hash.ts';
import { Timeout, TimeProvider } from '../src/Config.ts';

export interface MockNetworkOptions {
  connectLatencyMs: number;
  sendReliableLatencyMs: number;
  sendFastLatencyMs: number;
  sendFastDropRatio: number;
}

class TimerSet {
  private timeouts = new Set<Timeout>();

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

  constructor(private timeProvider: TimeProvider, private opts: MockNetworkOptions) {}

  public createInstance(driver: SignalingDriver) {
    const timerSet = new TimerSet(this.timeProvider);

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
      shutdown: () => {
        server.closeHandler!();
        // console.log('CLOSE', timeouts);
        timerSet.clearAll();
      },
    };

    this.servers.set(addr, server);
    driver.sendSignal(JSON.stringify({ addr, token: driver.myToken?.toHex() }));

    return {
      recvSignal: (signal: string) => {
        if (remote !== undefined) {
          throw new Error(`Extra signal ${signal}`);
        }

        const { addr, token } = JSON.parse(signal);

        remote = this.servers.get(addr);
        if (remote === undefined) {
          throw new Error(`Unable to connect to ${addr}`);
        }

        timerSet.set(
          () => {
            const connDriver = driver.createConnection(Hash.fromHex(token), server);

            if (server.recvHandler !== undefined) {
              throw new Error(`Cannot call onRecv multiple times!`);
            }
            server.recvHandler = connDriver.recvData;

            if (server.closeHandler !== undefined) {
              throw new Error(`Cannot call onClose multiple times!`);
            }
            server.closeHandler = connDriver.close;
          },
          (Math.random() + 0.5) * this.opts.connectLatencyMs,
        );
      },
    };
  }
}

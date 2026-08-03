// Test helper -- a pair of in-process transport plugins that dial each other.
//
// Delivery is deferred to a microtask, like every real transport: a synchronous
// hand-off would let one node's flood re-enter the other's ingestion.

import {
  AnonymousTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
} from '../../src/interfaces/transport.ts';
import { error } from '../../src/util/functional.ts';

export class LoopbackProvider implements ConnectionProvider {
  maxMsgSize?: number;
  sentChunks: Uint8Array[] = [];
  shutdownCalled = false;

  private peerProvider?: LoopbackProvider;
  private peerDriver?: ConnectionDriver;
  private pending: Uint8Array[] = [];
  private closed = false;

  constructor(maxMsgSize?: number) {
    this.maxMsgSize = maxMsgSize;
  }

  /** Called after the driver exists; anything sent before this is buffered. */
  link(peerProvider: LoopbackProvider, peerDriver: ConnectionDriver): void {
    this.peerProvider = peerProvider;
    this.peerDriver = peerDriver;
    this.flush();
  }

  sendReliable(data: Uint8Array): void {
    this.enqueue(data);
  }

  sendFast(data: Uint8Array): void {
    this.enqueue(data);
  }

  shutdown(): void {
    this.shutdownCalled = true;
    if (this.closed) return;
    this.closed = true;

    const peerProvider = this.peerProvider;
    const peerDriver = this.peerDriver;
    queueMicrotask(() => {
      if (peerProvider !== undefined) peerProvider.closed = true;
      peerDriver?.close();
    });
  }

  private enqueue(data: Uint8Array): void {
    if (this.closed) error(`Loopback connection is closed!`);
    this.sentChunks.push(data);
    this.pending.push(data);
    this.flush();
  }

  private flush(): void {
    const peerDriver = this.peerDriver;
    if (peerDriver === undefined) return;

    const batch = this.pending;
    this.pending = [];
    for (const data of batch) {
      queueMicrotask(() => {
        if (!this.closed) peerDriver.recvData(data);
      });
    }
  }
}

/** Registry of listening plugins, shared by every node in one test. */
export class LoopbackNetwork {
  private listeners = new Map<string, LoopbackTransportPlugin>();

  register(address: string, plugin: LoopbackTransportPlugin): void {
    this.listeners.set(address, plugin);
  }

  find(address: string): LoopbackTransportPlugin {
    return this.listeners.get(address) ?? error(`Nothing is listening on ${address}`);
  }
}

export class LoopbackTransportPlugin implements TransportPlugin {
  emitsProtocol = 'loopback';
  acceptsProtocols = ['loopback'];

  stoppedCount = 0;

  private driver?: AnonymousTransportDriver;

  constructor(
    private network: LoopbackNetwork,
    public address: string,
    private maxMsgSize?: number,
  ) {
    network.register(address, this);
  }

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    this.driver = anonymousDriver;

    return {
      announceAddresses: () => anonymousDriver.broadcastAddress(this.address),
      dialAddress: (address: string) => this.dial(address),
      stop: () => {
        this.stoppedCount += 1;
        return Promise.resolve();
      },
    };
  }

  private dial(address: string): void {
    const remote = this.network.find(address);

    const localProvider = new LoopbackProvider(this.maxMsgSize);
    const remoteProvider = new LoopbackProvider(remote.maxMsgSize);

    const localDriver = this.accept(localProvider);
    const remoteDriver = remote.accept(remoteProvider);

    localProvider.link(remoteProvider, remoteDriver);
    remoteProvider.link(localProvider, localDriver);
  }

  private accept(provider: LoopbackProvider): ConnectionDriver {
    const driver = this.driver ?? error(`Plugin for ${this.address} has not been started`);
    return driver.createAnonymousConnection(provider);
  }
}

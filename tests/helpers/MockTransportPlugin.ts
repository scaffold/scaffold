// Test helper -- mock TransportPlugin implementation.
//
// Provides hooks to inject connections and signals for unit tests. Supports
// both anonymous and authenticated modes.

import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../../src/interfaces/transport.ts';

export class MockConnectionProvider implements ConnectionProvider {
  readonly sent: Uint8Array[] = [];
  shutdownCalled = false;

  sendReliable(data: Uint8Array): void {
    this.sent.push(data);
  }

  sendFast(data: Uint8Array): void {
    this.sent.push(data);
  }

  shutdown(): void {
    this.shutdownCalled = true;
  }
}

export interface MockAuthSession {
  driver: AuthenticatedTransportDriver;
  session: TransportSession;
  sentSignals: string[];
}

export class MockTransportPlugin implements TransportPlugin {
  readonly emitsProtocol: string | undefined;
  readonly acceptsProtocols: string[];

  anonymousDriver?: AnonymousTransportDriver;
  startedCount = 0;
  stoppedCount = 0;
  announceCount = 0;
  readonly dialCalls: string[] = [];
  readonly authSessions: MockAuthSession[] = [];

  constructor(
    options: { emitsProtocol?: string | null; acceptsProtocols?: string[] } = {},
  ) {
    this.emitsProtocol = options.emitsProtocol === null
      ? undefined
      : (options.emitsProtocol ?? 'mock');
    this.acceptsProtocols = options.acceptsProtocols ?? ['mock'];
  }

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    this.startedCount += 1;
    this.anonymousDriver = anonymousDriver;

    return {
      announceAddresses: () => {
        this.announceCount += 1;
      },
      dialAddress: (address: string) => {
        this.dialCalls.push(address);
      },
      initializeAuthenticatedTransport: (driver: AuthenticatedTransportDriver) => {
        const sentSignals: string[] = [];
        const originalSend = driver.sendSignal.bind(driver);
        const wrappedDriver: AuthenticatedTransportDriver = {
          sendSignal: (signal: string) => {
            sentSignals.push(signal);
            originalSend(signal);
          },
          createAuthenticatedConnection: driver.createAuthenticatedConnection.bind(driver),
        };
        const recvQueue: string[] = [];
        const session: TransportSession = {
          recvSignal: (signal: string) => {
            recvQueue.push(signal);
          },
          close: () => {},
        };
        const entry: MockAuthSession = {
          driver: wrappedDriver,
          session,
          sentSignals,
        };
        this.authSessions.push(entry);
        return session;
      },
      stop: () => {
        this.stoppedCount += 1;
        return Promise.resolve();
      },
    };
  }

  /** Simulate an inbound anonymous connection arriving through this plugin. */
  injectAnonymousConnection(): { provider: MockConnectionProvider; driver: ConnectionDriver } {
    const provider = new MockConnectionProvider();
    const driver = this.anonymousDriver!.createAnonymousConnection(provider);
    return { provider, driver };
  }

  /**
   * Simulate producing an authenticated connection from the most recently
   * created session.
   */
  injectAuthenticatedConnection(
    entry: MockAuthSession = this.authSessions[this.authSessions.length - 1],
  ): { provider: MockConnectionProvider; driver: ConnectionDriver } {
    const provider = new MockConnectionProvider();
    const driver = entry.driver.createAuthenticatedConnection(provider);
    return { provider, driver };
  }
}

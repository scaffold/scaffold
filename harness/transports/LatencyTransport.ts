/**
 * TransportPlugin wrapper that injects simulated latency (+ jitter) into
 * outbound writes. Both sides of a connection wrap their outbound, so
 * observed RTT between A and B equals `one_way(A -> B) + one_way(B -> A)`.
 *
 * V1 limitations (documented in TODO.md if we hit them):
 *   - Outbound-dial coord lookup uses a FIFO queue keyed by dial order.
 *     Concurrent dials may swap coords if resolutions arrive out of order.
 *     In practice bootstrap dials are few and resolve quickly, and fleet
 *     coord variance is small enough that this is noise.
 *   - Inbound accepted connections have no peer identity at the plugin
 *     layer, so they use the fleet fallback latency. Peer migration
 *     experiments that care about identity-aware latency on ingress
 *     should read delays from postgres on the sender side, not the
 *     receiver side.
 */

import type {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../../src/interfaces/transport.ts';
import type { Coord } from '../types.ts';
import type { Geography } from '../geography.ts';
import type { Rng } from '../rand.ts';
import type { PeerDirectory } from './PeerDirectory.ts';

export interface LatencyTransportOptions {
  inner: TransportPlugin;
  localCoord: Coord;
  directory: PeerDirectory;
  geography: Geography;
  rand: Rng;
  /** Latency used when the remote's coord is not resolvable (inbound). */
  fleetFallbackMs: number;
}

export class LatencyTransport implements TransportPlugin {
  readonly emitsProtocol: string | undefined;
  readonly acceptsProtocols: string[];

  private readonly pendingDialCoords: Array<Coord | undefined> = [];

  constructor(private readonly opts: LatencyTransportOptions) {
    this.emitsProtocol = opts.inner.emitsProtocol;
    this.acceptsProtocols = opts.inner.acceptsProtocols;
  }

  start(anonymousDriver: AnonymousTransportDriver): TransportService {
    const wrappedAnon: AnonymousTransportDriver = {
      broadcastAddress: (sig) => anonymousDriver.broadcastAddress(sig),
      createAnonymousConnection: (provider: ConnectionProvider): ConnectionDriver => {
        const coord = this.pendingDialCoords.shift(); // undefined for inbound
        const wrapped = this.wrapProvider(provider, coord);
        return anonymousDriver.createAnonymousConnection(wrapped);
      },
    };

    const service = this.opts.inner.start(wrappedAnon);

    return {
      announceAddresses: service.announceAddresses ? () => service.announceAddresses!() : undefined,

      dialAddress: service.dialAddress
        ? (address: string) => {
          const peer = this.opts.directory.getByAddress(address);
          this.pendingDialCoords.push(peer?.coord);
          service.dialAddress!(address);
        }
        : undefined,

      initializeAuthenticatedTransport: service.initializeAuthenticatedTransport
        ? (driver: AuthenticatedTransportDriver): TransportSession => {
          const wrappedDriver: AuthenticatedTransportDriver = {
            sendSignal: (s) => driver.sendSignal(s),
            createAuthenticatedConnection: (provider): ConnectionDriver => {
              // Plugin layer does not know the peer pubkey here; use
              // fleet fallback. (See file header comment.)
              const wrapped = this.wrapProvider(provider, undefined);
              return driver.createAuthenticatedConnection(wrapped);
            },
          };
          return service.initializeAuthenticatedTransport!(wrappedDriver);
        }
        : undefined,

      stop: () => service.stop(),
    };
  }

  private wrapProvider(
    inner: ConnectionProvider,
    remoteCoord: Coord | undefined,
  ): ConnectionProvider {
    const delayMs = () => {
      if (!remoteCoord) return this.opts.fleetFallbackMs;
      return this.opts.geography.oneWayLatencyMs(
        this.opts.localCoord,
        remoteCoord,
        this.opts.rand,
      );
    };

    return {
      maxMsgSize: inner.maxMsgSize,
      sendReliable: (data) => {
        const ms = delayMs();
        if (ms <= 0) {
          inner.sendReliable(data);
          return;
        }
        setTimeout(() => inner.sendReliable(data), ms);
      },
      sendFast: (data) => {
        const ms = delayMs();
        if (ms <= 0) {
          inner.sendFast(data);
          return;
        }
        setTimeout(() => inner.sendFast(data), ms);
      },
      shutdown: () => inner.shutdown(),
    };
  }
}

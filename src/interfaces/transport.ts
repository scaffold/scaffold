// Protocol spec: docs/protocol/transport.md
//
// Transport plugins abstract over a specific byte-level transport (WebRTC,
// WebSocket, Unix socket, etc.). Scaffold uses a single TransportPlugin
// interface for all transports and an emit/accept capability system to
// carve out client/server asymmetries.
//
// Matching rule: peer X and peer Y can negotiate iff X's emitsProtocol
// appears in Y's acceptsProtocols, or vice versa.

// -- Byte channel (shared between anonymous and authenticated) ---------

/** Byte-level outbound channel the plugin provides after opening a connection. */
export interface ConnectionProvider {
  maxMsgSize?: number;

  /** Must not be dropped or mangled; order not required. */
  sendReliable(data: Uint8Array): void;

  /** Send fast; drops are fine. */
  sendFast(data: Uint8Array): void;

  shutdown(): void;
}

/** Byte-level inbound callbacks Scaffold returns to the plugin. */
export interface ConnectionDriver {
  recvData(data: Uint8Array): void;

  /** Call when the underlying transport closes. */
  close(): void;
}

// -- Anonymous mode (bootstrap, local testing, untrusted relay) --------

/** Driver provided by Scaffold to plugins for anonymous (unauthenticated) connections. */
export interface AnonymousTransportDriver {
  /** Announce the current set of reachable address so other peers can bootstrap to us. */
  announceAddresses(urls: URL[]): void;

  /** Register a newly-opened anonymous connection with Scaffold. */
  createAnonymousConnection(connection: ConnectionProvider): ConnectionDriver;
}

// -- Authenticated mode (peer-to-peer with pubkey identity) ------------

/** Driver provided by Scaffold for a single authenticated handshake session. Peer-scoped. */
export interface AuthenticatedTransportDriver {
  /** Send a signal to the remote peer; Scaffold encrypts and mesh-relays. */
  sendSignal(signal: string): void;

  /** Register a newly-opened authenticated connection. Identity is implicit. */
  createAuthenticatedConnection(connection: ConnectionProvider): ConnectionDriver;
}

/** Per-handshake object the plugin returns to receive inbound signals. */
export interface TransportSession {
  recvSignal(signal: string): void;

  /** Called by Scaffold after a connection is produced or on timeout. */
  close(): void;
}

// -- Service (running state of a plugin) -------------------------------

export interface TransportService {
  /** Scaffold hands the plugin a bootstrap address to dial anonymously. */
  dialAddress?(url: URL): void;

  /** Scaffold begins an authenticated handshake with a specific peer. */
  initializeAuthenticatedTransport?(driver: AuthenticatedTransportDriver): TransportSession;

  stop(): Promise<void>;
}

// -- Plugin (user-provided entry point) --------------------------------

export interface TransportPlugin {
  name: string;

  /** Anonymous. A predicate, not a list: the URL is always a concrete local
   *  value, so nothing needs to enumerate this. */
  acceptsUrl?(url: URL): boolean;

  /** Signaling protocol this plugin emits signals/addresses for (attached to sendSignal). */
  emitsProtocol?: string;

  /** Signaling protocols this plugin consumes (attached to recvSignal). */
  acceptsProtocols: string[];

  start(anonymousDriver: AnonymousTransportDriver): TransportService;
}

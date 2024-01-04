import Context from './Context.ts';

export interface ConnectionProvider {
  // Does not need to maintain order between sends, but does need to make sure packet's aren't dropped or mangled.
  // TODO: Should we require ordering?
  sendReliable(data: Uint8Array): void;

  // Just send it fast. No worries if it drops.
  sendFast(data: Uint8Array): void;

  onRecv(handler: (data: Uint8Array) => void): void;

  shutdown(): void;

  // Call this handler when the transport closes
  onClose(handler: () => void): void;
}

interface NetworkProviderOld {
  readonly protocolName: string;

  createServer?(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
    ctx: Context, // TODO: Maybe move this parameter first; we don't want it to be ignored?
  ): void;

  // Only call onNewConn once the connection is established and data can be sent.
  // You can call tryConnect as often as you'd like. Calls after the connection is established are no-ops.
  // Don't call onListen after onNewConn is called.
  createClient?(
    // onListen events will be transmitted to the remote node via tryConnect
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
    ctx: Context, // TODO: Maybe move this parameter first; we don't want it to be ignored?
  ): {
    tryConnect(spec: string): void;
  };
}

export interface SignalingDriver {
  ctx: Context;

  protocolName: string;
  isInitiator: boolean;

  sendSignal(signal: string): void;
  createConnection(conn: ConnectionProvider): void;
}

export interface SignalingProvider {
  recvSignal(signal: string): void;
}

export default interface NetworkProvider {
  readonly protocols?: string | string[];

  createInstance(driver: SignalingDriver): SignalingProvider;
}

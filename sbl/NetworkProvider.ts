export type ConnectionProvider = {
  // Does not need to maintain order between sends, but does need to make sure packet's aren't dropped or mangled.
  sendReliable(data: Uint8Array): void;

  // Just send it fast. No worries if it drops.
  sendFast(data: Uint8Array): void;

  onRecv(handler: (data: Uint8Array) => void): void;

  // After close() is called, the provider must call the method passed to onClose().
  close(): void;
  onClose(handler: () => void): void;
};

export type ProtocolProvider = {
  // Only call onNewConn once the connection is established and data is ready to be sent.
  // You can call tryConnect as often as you'd like. Calls after the connection is established are no-ops.
  // Don't call onListen after onNewConn is called.
  create(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ): {
    tryConnect(spec: string): void;
  };

  serve?(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ): void;
};

type NetworkProvider = {
  protocols: Map<string, ProtocolProvider>;
};

export default NetworkProvider;

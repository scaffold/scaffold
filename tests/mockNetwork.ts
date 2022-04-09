import Hash from '~/sbl/util/Hash.ts';
import {
  ConnectionProvider,
  ProtocolProvider,
} from '../sbl/NetworkProvider.ts';

const servers: Map<
  string,
  { connect: (send: (data: Uint8Array) => void) => (data: Uint8Array) => void }
> = new Map();

export const makeMockNetworkProvider = (opts: {
  connectLatencyMs: number;
  sendReliableLatencyMs: number;
  sendFastLatencyMs: number;
  sendFastDropRatio: number;
}): ProtocolProvider => ({
  create: (
    _onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    let send: (data: Uint8Array) => void;

    return {
      tryConnect: (spec: string) => {
        const server = servers.get(spec);
        if (!server) {
          console.error(`Tried connecting to a non-existent spec ${spec}`);
          return;
        }

        setTimeout(() =>
          onNewConn({
            sendReliable: (data: Uint8Array) =>
              setTimeout(
                () => send(data),
                (Math.random() + 0.5) * opts.sendReliableLatencyMs,
              ),
            sendFast: (data: Uint8Array) =>
              Math.random() > opts.sendFastDropRatio &&
              setTimeout(
                () => send(data),
                (Math.random() + 0.5) * opts.sendFastLatencyMs,
              ),
            onRecv: (handler: (data: Uint8Array) => void) => {
              send = server.connect(handler);
            },
            close: () => {},
            onClose: (_handler: () => void) => {},
          }), (Math.random() + 0.5) * opts.connectLatencyMs);
      },
    };
  },

  serve: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    const addr = Hash.random().toHex();
    servers.set(addr, {
      connect: (send: (data: Uint8Array) => void) => {
        let recvHandler: (data: Uint8Array) => void;
        onNewConn({
          sendReliable: (data: Uint8Array) =>
            setTimeout(
              () => send(data),
              (Math.random() + 0.5) * opts.sendReliableLatencyMs,
            ),
          sendFast: (data: Uint8Array) =>
            Math.random() > opts.sendFastDropRatio &&
            setTimeout(
              () => send(data),
              (Math.random() + 0.5) * opts.sendFastLatencyMs,
            ),
          onRecv: (handler: (data: Uint8Array) => void) => {
            recvHandler = handler;
          },
          close: () => {},
          onClose: (_handler: () => void) => {},
        });
        return recvHandler!;
      },
    });
    onListen(addr);
  },
});

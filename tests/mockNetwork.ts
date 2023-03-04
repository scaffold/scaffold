import Hash from '~/sbl/util/Hash.ts';
import { Packet } from '../sbl/messages.ts';
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
  createClient: (
    _onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    let send: (data: Uint8Array) => void;
    const onClose: (() => void)[] = [];
    const timeouts: number[] = [];

    return {
      tryConnect: (spec: string) => {
        const server = servers.get(spec);
        if (!server) {
          console.error(`Tried connecting to a non-existent spec ${spec}`);
          return;
        }

        timeouts.push(setTimeout(() =>
          onNewConn({
            sendReliable: (data: Uint8Array) =>
              timeouts.push(setTimeout(
                () => send(data),
                (Math.random() + 0.5) * opts.sendReliableLatencyMs,
              )),
            sendFast: (data: Uint8Array) =>
              Math.random() > opts.sendFastDropRatio &&
              timeouts.push(setTimeout(
                () => send(data),
                (Math.random() + 0.5) * opts.sendFastLatencyMs,
              )),
            onRecv: (handler: (data: Uint8Array) => void) => {
              send = server.connect(handler);
            },
            close: () => {
              onClose.forEach((cb) => cb());
              timeouts.forEach((t) => clearTimeout(t));
            },
            onClose: (handler: () => void) => onClose.push(handler),
          }), (Math.random() + 0.5) * opts.connectLatencyMs));
      },
    };
  },

  createServer: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    const onClose: (() => void)[] = [];
    const timeouts: number[] = [];

    const addr = Hash.random().toHex();
    servers.set(addr, {
      connect: (send: (data: Uint8Array) => void) => {
        let recvHandler: (data: Uint8Array) => void;
        onNewConn({
          sendReliable: (data: Uint8Array) =>
            // console.log(
            //   Packet.decode(data.subarray(64)),
            timeouts.push(setTimeout(
              () => send(data),
              (Math.random() + 0.5) * opts.sendReliableLatencyMs,
            )),
          // ),
          sendFast: (data: Uint8Array) =>
            Math.random() > opts.sendFastDropRatio &&
            timeouts.push(setTimeout(
              () => send(data),
              (Math.random() + 0.5) * opts.sendFastLatencyMs,
            )),
          onRecv: (handler: (data: Uint8Array) => void) => {
            recvHandler = handler;
          },
          close: () => {
            onClose.forEach((cb) => cb());
            // console.log('CLOSE', timeouts);
            timeouts.forEach((t) => clearTimeout(t));
          },
          onClose: (handler: () => void) => onClose.push(handler),
        });
        return recvHandler!;
      },
    });
    onListen(addr);
  },
});

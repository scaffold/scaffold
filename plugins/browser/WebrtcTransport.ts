// Protocol spec: docs/protocol/transport.md
//
// TransportPlugin for WebRTC in the browser. Symmetric: emits and accepts
// 'webrtc' signals. Each session owns one RTCPeerConnection and the SDP/ICE
// handshake runs over the encrypted signaling channel. DTLS inside WebRTC
// provides mutual identity binding via the fingerprint in the SDP.

import {
  AnonymousTransportDriver,
  AuthenticatedTransportDriver,
  ConnectionProvider,
  TransportPlugin,
  TransportService,
  TransportSession,
} from '../../src/interfaces/transport.ts';
import { Logger } from '../../src/interfaces/LoggingProvider.ts';
import { assert } from '../../src/util/functional.ts';
import { Hash } from '../../src/util/Hash.ts';
import { isUnshared } from '../util.ts';

const defaultMaxMsgSize = 65536;

export class WebrtcTransport implements TransportPlugin {
  name = 'WebrtcTransport';
  emitsProtocol = 'webrtc';
  acceptsProtocols = ['webrtc'];

  private iceServersPromise: Promise<{ urls: string; order: number }[]>;

  // The plugin has no Context, so a host that wants diagnostics passes one in.
  constructor(private log?: Logger) {
    this.iceServersPromise = Promise.all(
      [
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt',
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv4s.txt',
      ].map((url) =>
        fetch(url).then((resp) => resp.text(), (err) => {
          this.log?.warn('iceServerFetchFailed', { url, err });
          return '';
        })
      ),
    ).then((resps) =>
      resps
        .flatMap((resp) => resp.split('\n'))
        .filter(Boolean)
        .map((host) => ({ urls: `stun:${host}`, order: Math.random() }))
        .sort((a, b) => a.order - b.order)
        .slice(0, 2)
    );
  }

  start(_anonymousDriver: AnonymousTransportDriver): TransportService {
    return {
      initializeAuthenticatedTransport: (driver: AuthenticatedTransportDriver): TransportSession =>
        this.openSession(driver),
    };
  }

  private openSession(driver: AuthenticatedTransportDriver): TransportSession {
    const myOrderHash = Hash.random();

    let reliableChannel: RTCDataChannel | undefined;
    let fastChannel: RTCDataChannel | undefined;
    const bufferedPackets: ArrayBuffer[] = [];

    const dispatchNewConn = (conn: RTCPeerConnection) => {
      let maxMsgSize: number;
      if (conn.sctp !== null) {
        maxMsgSize = conn.sctp.maxMessageSize;
      } else {
        maxMsgSize = defaultMaxMsgSize;
      }

      const provider: ConnectionProvider = {
        maxMsgSize,
        sendReliable: (data: Uint8Array) => {
          assert(isUnshared(data));
          reliableChannel!.send(data);
        },
        sendFast: (data: Uint8Array) => {
          assert(isUnshared(data));
          fastChannel!.send(data);
        },
        shutdown: () => conn.close(),
      };

      const connDriver = driver.createAuthenticatedConnection(provider);

      for (const packet of bufferedPackets) {
        connDriver.recvData(new Uint8Array(packet));
      }
      bufferedPackets.length = 0;

      const messageHandler = (e: MessageEvent<ArrayBuffer>) =>
        connDriver.recvData(new Uint8Array(e.data));
      reliableChannel!.onmessage = messageHandler;
      fastChannel!.onmessage = messageHandler;

      conn.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(conn.connectionState)) {
          connDriver.close();
        }
      };
    };

    const createChannels = (conn: RTCPeerConnection) => {
      reliableChannel = conn.createDataChannel('reliable', {
        negotiated: true,
        id: 0,
        ordered: true,
        maxRetransmits: undefined,
      });
      setupChannel(conn, reliableChannel);

      fastChannel = conn.createDataChannel('fast', {
        negotiated: true,
        id: 1,
        ordered: false,
        maxRetransmits: 0,
      });
      setupChannel(conn, fastChannel);
    };

    const setupChannel = (conn: RTCPeerConnection, channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';
      channel.onopen = (_e) => {
        if (
          reliableChannel?.readyState === 'open' &&
          fastChannel?.readyState === 'open'
        ) {
          dispatchNewConn(conn);
        }
      };
      channel.onmessage = (e) => bufferedPackets.push(e.data);
      channel.onerror = (e) => this.log?.error('channelError', { err: e });
      channel.onclose = (_e) => conn.close();
    };

    const connPromise = (async () => {
      driver.sendSignal(JSON.stringify({
        orderHex: myOrderHash.toHex(),
      }));

      const config = { iceServers: await this.iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.onicecandidate = (e) =>
        e.candidate &&
        driver.sendSignal(JSON.stringify({ iceCandidate: e.candidate }));

      return conn;
    })();

    const recvSignal = async (spec: string) => {
      const { orderHex, offer, answer, iceCandidate } = JSON.parse(spec);
      const conn = await connPromise;

      if (orderHex) {
        createChannels(conn);

        const cmp = Hash.compare(myOrderHash, Hash.fromHex(orderHex));
        if (cmp < 0) {
          const offer = await conn.createOffer();
          await conn.setLocalDescription(offer);
          driver.sendSignal(JSON.stringify({ offer: conn.localDescription }));
        } else if (cmp === 0) {
          this.log?.error('orderingHashEquality', {});
        }
      }
      if (offer) {
        await conn.setRemoteDescription(offer);
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        driver.sendSignal(JSON.stringify({ answer: conn.localDescription }));
      }
      if (answer) {
        await conn.setRemoteDescription(answer);
      }
      if (iceCandidate) {
        conn.addIceCandidate(iceCandidate);
      }
    };

    return {
      recvSignal: (signal: string) => {
        void recvSignal(signal);
      },
      close: () => {
        connPromise.then((conn) => {
          try {
            conn.close();
          } catch { /* ignore */ }
        });
      },
    };
  }
}

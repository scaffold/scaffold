import { NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';
import { Hash } from '../src/util/Hash.ts';
import { MessageJoiner, MessageSplitter } from './MessageSplitter.ts';
import { orderSignals } from './util.ts';

const defaultMaxMsgSize = 65536;

export class WebrtcProvider implements NetworkProvider {
  public providesProtocol = 'webrtc@0.0.1';

  private iceServersPromise: Promise<{ urls: string; order: number }[]>;

  constructor() {
    this.iceServersPromise = Promise.all(
      [
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt',
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv4s.txt',
      ].map((url) =>
        fetch(url).then((resp) => resp.text(), (err) => {
          console.warn(err);
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

  public createInstance(signalingDriver: SignalingDriver) {
    // TODO: Use driver.isInitiator for ordering
    const myOrderHash = Hash.random();

    let remoteToken: Hash | undefined;

    let reliableChannel: RTCDataChannel | undefined;
    let fastChannel: RTCDataChannel | undefined;
    const joiner = new MessageJoiner();
    const bufferedPackets: ArrayBuffer[] = [];

    const dispatchNewConn = (conn: RTCPeerConnection) => {
      let msgSize;
      if (conn.sctp !== null) {
        msgSize = conn.sctp.maxMessageSize;
        console.info(`Using a max message size of ${msgSize}`);
      } else {
        msgSize = defaultMaxMsgSize;
        console.warn(`No WebRTC sctp property set! Using a default max message size of ${msgSize}`);
      }

      const reliableSplitter = new MessageSplitter(msgSize);
      const fastSplitter = new MessageSplitter(msgSize);

      const connDriver = signalingDriver.createConnection(remoteToken, {
        sendReliable: (data: Uint8Array) => {
          for (const packet of reliableSplitter.send(data)) {
            reliableChannel!.send(packet);
          }
        },
        sendFast: (data: Uint8Array) => {
          for (const packet of fastSplitter.send(data)) {
            fastChannel!.send(packet);
          }
        },
        shutdown: () => conn.close(),
      });

      for (const packet of bufferedPackets) {
        for (const msg of joiner.recv(packet)) {
          connDriver.recvData(msg);
        }
      }
      bufferedPackets.length = 0;

      const messageHandler = (e: MessageEvent<ArrayBuffer>) => {
        for (const msg of joiner.recv(e.data)) {
          connDriver.recvData(msg);
        }
      };
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
      channel.onerror = (e) => console.error(`WebRTC error:`, e);
      channel.onclose = (_e) => conn.close();
    };

    const connPromise = (async () => {
      signalingDriver.sendSignal(JSON.stringify({
        token: signalingDriver.myToken?.toHex(),
        orderHex: myOrderHash.toHex(),
      }));

      const config = { iceServers: await this.iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.onicecandidate = (e) =>
        e.candidate &&
        signalingDriver.sendSignal(JSON.stringify({ iceCandidate: e.candidate }), 0.25);

      return conn;
    })();

    return {
      recvSignal: orderSignals(async (spec: string) => {
        const { token, orderHex, offer, answer, iceCandidate } = JSON.parse(spec);
        const conn = await connPromise;

        if (token) {
          remoteToken = Hash.fromHex(token);
        }
        if (orderHex) {
          createChannels(conn);

          const cmp = Hash.compare(myOrderHash, Hash.fromHex(orderHex));
          if (cmp < 0) {
            const offer = await conn.createOffer();
            await conn.setLocalDescription(offer);
            signalingDriver.sendSignal(JSON.stringify({ offer: conn.localDescription }));
          } else if (cmp === 0) {
            console.error(
              `Error negotiating WebRTC connection ordering assignment: Hash equality`,
            );
          }
        }
        if (offer) {
          await conn.setRemoteDescription(offer);
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          signalingDriver.sendSignal(JSON.stringify({ answer: conn.localDescription }));
        }
        if (answer) {
          await conn.setRemoteDescription(answer);
        }
        if (iceCandidate) {
          conn.addIceCandidate(iceCandidate);
        }
      }),
    };
  }
}

import { NetworkProvider, SignalingDriver } from '../src/NetworkProvider.ts';
import { Hash } from '../src/util/Hash.ts';
import { orderSignals } from './util.ts';

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
    );
  }

  public createInstance(driver: SignalingDriver) {
    // TODO: Use driver.isInitiator for ordering
    const myOrderHash = Hash.random();

    let reliableChannel: RTCDataChannel | undefined;
    let fastChannel: RTCDataChannel | undefined;
    const bufferedMsgs: Uint8Array[] = [];
    const isOpen: { [key: string]: boolean } = { reliable: false, fast: false };

    const dispatchNewConn = (conn: RTCPeerConnection) =>
      driver.createConnection({
        sendReliable: (data: Uint8Array) => reliableChannel!.send(data),
        sendFast: (data: Uint8Array) => fastChannel!.send(data),
        onRecv: (handler: (data: Uint8Array) => void) => {
          bufferedMsgs.forEach(handler);
          bufferedMsgs.length = 0;
          const messageHandler = (e: MessageEvent<ArrayBuffer>) =>
            handler(new Uint8Array(e.data));
          reliableChannel!.onmessage = messageHandler;
          fastChannel!.onmessage = messageHandler;
        },
        shutdown: () => conn.close(),
        onClose: (handler: () => void) =>
          conn.onconnectionstatechange = () =>
            ['disconnected', 'failed', 'closed'].includes(
              conn.connectionState,
            ) && handler(),
      });
    const createChannels = (conn: RTCPeerConnection) => {
      reliableChannel = conn.createDataChannel('reliable', {
        ordered: true,
        maxRetransmits: undefined,
      });
      setupChannel(conn, reliableChannel);

      fastChannel = conn.createDataChannel('fast', {
        ordered: false,
        maxRetransmits: 0,
      });
      setupChannel(conn, fastChannel);
    };
    const listenForChannels = (conn: RTCPeerConnection) => {
      conn.ondatachannel = (e) => {
        switch (e.channel.label) {
          case 'reliable':
            reliableChannel = e.channel;
            setupChannel(conn, reliableChannel);
            break;

          case 'fast':
            fastChannel = e.channel;
            setupChannel(conn, fastChannel);
            break;

          default:
            throw new Error(`Unexpected channel label ${e.channel.label}`);
        }
      };
    };
    const setupChannel = (conn: RTCPeerConnection, channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';
      channel.onopen = (_e) => {
        isOpen[channel.label] = true;
        if (isOpen['reliable'] && isOpen['fast']) {
          dispatchNewConn(conn);
        }
      };
      channel.onmessage = (e) => bufferedMsgs.push(new Uint8Array(e.data));
      channel.onclose = (_e) => {
        isOpen[channel.label] = false;
        conn.close();
      };
    };

    const connPromise = (async () => {
      driver.sendSignal(JSON.stringify({ orderHex: myOrderHash.toHex() }));

      const config = { iceServers: await this.iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.onicecandidate = (e) =>
        e.candidate &&
        driver.sendSignal(JSON.stringify({ iceCandidate: e.candidate }), 0.25);

      return conn;
    })();

    return {
      recvSignal: orderSignals(async (spec: string) => {
        const { orderHex, offer, answer, iceCandidate } = JSON.parse(spec);
        const conn = await connPromise;

        if (orderHex) {
          const cmp = Hash.compare(myOrderHash, Hash.fromHex(orderHex));
          if (cmp < 0) {
            createChannels(conn);
            const offer = await conn.createOffer();
            await conn.setLocalDescription(offer);
            driver.sendSignal(JSON.stringify({ offer: conn.localDescription }));
          } else {
            listenForChannels(conn);
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
      }),
    };
  }
}

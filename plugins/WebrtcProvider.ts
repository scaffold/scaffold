import NetworkProvider, {
  ConnectionProvider,
  ListeningMode,
} from '~/sbl/NetworkProvider.ts';
import Hash from '~/sbl/util/Hash.ts';

export default class WebrtcProvider implements NetworkProvider {
  public protocolName = 'webrtc';
  public listeningMode = ListeningMode.Unique;

  private iceServersPromise: Promise<{ urls: string; order: number }[]>;

  constructor() {
    this.iceServersPromise = Promise.all(
      [
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_hosts.txt',
        'https://raw.githubusercontent.com/pradt2/always-online-stun/master/valid_ipv4s.txt',
      ].map((url) => fetch(url).then((resp) => resp.text())),
    ).then((resps) =>
      resps
        .flatMap((resp) => resp.trim().split('\n'))
        .map((host) => ({ urls: `stun:${host}`, order: Math.random() }))
        .sort((a, b) => a.order - b.order)
    );
  }

  public createClient(
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) {
    const orderHash = Hash.random();

    let reliableChannel: RTCDataChannel | undefined;
    let fastChannel: RTCDataChannel | undefined;
    const bufferedMsgs: Uint8Array[] = [];
    const isOpen: { [key: string]: boolean } = {
      reliable: false,
      fast: false,
    };

    const dispatchNewConn = (conn: RTCPeerConnection) =>
      onNewConn({
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
        onClose: (_handler: () => void) =>
          conn.onconnectionstatechange = (e) =>
            console.log(
              'onconnectionstatechange',
              e,
              conn.connectionState,
            ),
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
    const setupChannel = (
      conn: RTCPeerConnection,
      channel: RTCDataChannel,
    ) => {
      console.log('READYSTATE', channel.readyState);
      channel.binaryType = 'arraybuffer';
      channel.onopen = (_e) => {
        isOpen[channel.label] = true;
        if (isOpen['reliable'] && isOpen['fast']) {
          console.log('READY');
          dispatchNewConn(conn);
        }
      };
      channel.onmessage = (e) => bufferedMsgs.push(new Uint8Array(e.data));
      channel.onclose = (_e) => {
        isOpen[channel.label] = false;
      };
    };

    const connPromise = (async () => {
      onListen(JSON.stringify({ orderHex: orderHash.toHex() }));

      const config = { iceServers: await this.iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.onicecandidate = (e) =>
        e.candidate &&
        onListen(JSON.stringify({ iceCandidate: e.candidate }));

      return conn;
    })();

    return {
      tryConnect: async (spec: string) => {
        console.log(JSON.parse(spec));

        const { orderHex, offer, answer, iceCandidate } = JSON.parse(spec);
        const conn = await connPromise;

        if (orderHex) {
          const cmp = Hash.compare(orderHash, Hash.fromHex(orderHex));
          if (cmp < 0) {
            await createChannels(conn);
            const offer = await conn.createOffer();
            await conn.setLocalDescription(offer);
            onListen(JSON.stringify({ offer: conn.localDescription }));
          } else {
            listenForChannels(conn);
          }
        }
        if (offer) {
          await conn.setRemoteDescription(offer);
          const answer = await conn.createAnswer();
          await conn.setLocalDescription(answer);
          onListen(JSON.stringify({ answer: conn.localDescription }));
        }
        if (answer) {
          await conn.setRemoteDescription(answer);
        }
        if (iceCandidate) {
          conn.addIceCandidate(iceCandidate);
        }
      },
    };
  }
}

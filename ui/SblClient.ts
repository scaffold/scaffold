import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config from '~/sbl/Config.ts';
import { ConnectionProvider, ProtocolProvider } from '~/sbl/NetworkProvider.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import QuestionService from '~/sbl/QuestionService.ts';
import SampleContracts from '~/graph/SampleContracts.ts';
import EpochContract from '~/graph/EpochContract.ts';
import Answer from '~/sbl/Answer.ts';

// window['Deno'] = {};

const websocketProvider: ProtocolProvider = {
  create: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    const sockets: WebSocket[] = [];

    return {
      tryConnect: (spec: string) => {
        const socket = new WebSocket(spec);
        socket.binaryType = 'arraybuffer';
        sockets.push(socket);
        socket.addEventListener(
          'open',
          () => {
            // Close any other attempted sockets
            sockets.forEach((s) => s !== socket && s.close());

            onNewConn({
              sendReliable: (data: Uint8Array) => socket.send(data),
              sendFast: (data: Uint8Array) => socket.send(data),
              onRecv: (handler: (data: Uint8Array) => void) =>
                socket.addEventListener(
                  'message',
                  (e) => handler(new Uint8Array(e.data)),
                ),
              close: () => socket.close(),
              onClose: (handler: () => void) =>
                socket.addEventListener('close', () => handler()),
            });
          },
        );
      },
    };
  },
};

const iceServersPromise = Promise.all(
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

const webrtcProvider: ProtocolProvider = {
  create: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    const connPromise = (async () => {
      const config = { iceServers: await iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.ondatachannel = (e) => console.log('ondatachannel', e);

      const reliableChannel = conn.createDataChannel('reliable', {
        ordered: true,
        maxRetransmits: undefined,
      });
      reliableChannel.binaryType = 'arraybuffer';
      reliableChannel.onopen = (e) => console.log('onopen', e);
      reliableChannel.onmessage = (e) => console.log('onmessage', e.data);
      reliableChannel.onclose = (e) => console.log('onclose', e);

      const fastChannel = conn.createDataChannel('fast', {
        ordered: false,
        maxRetransmits: 0,
      });
      fastChannel.binaryType = 'arraybuffer';
      fastChannel.onopen = (e) => console.log('onopen', e);
      fastChannel.onmessage = (e) => console.log('onmessage', e.data);
      fastChannel.onclose = (e) => console.log('onclose', e);

      conn.onicecandidate = (e) =>
        e.candidate && onListen(JSON.stringify({ iceCandidate: e.candidate }));

      conn.createOffer().then((offer) => conn.setLocalDescription(offer)).then(
        () => onListen(JSON.stringify({ offer: conn.localDescription })),
      );

      const onSomething = () =>
        onNewConn({
          sendReliable: (data: Uint8Array) => reliableChannel.send(data),
          sendFast: (data: Uint8Array) => fastChannel.send(data),
          onRecv: (handler: (data: Uint8Array) => void) => {
            reliableChannel.onmessage = (e) => handler(new Uint8Array(e.data));
            fastChannel.onmessage = (e) => handler(new Uint8Array(e.data));
          },
          close: () => conn.close(),
          onClose: (handler: () => void) =>
            conn.onconnectionstatechange = (e) =>
              console.log('onconnectionstatechange', e, conn.connectionState),
        });

      return conn;
    })();

    return {
      tryConnect: async (spec: string) => {
        const conn = await connPromise;

        const { offer, answer, iceCandidate } = JSON.parse(spec);

        if (offer) {
          conn.setRemoteDescription(offer).then(() => conn.createAnswer())
            .then((answer) => conn.setLocalDescription(answer))
            .then(() =>
              onListen(JSON.stringify({ answer: conn.localDescription }))
            );
        }
        if (answer) {
          conn.setRemoteDescription(answer);
        }
        if (iceCandidate) {
          conn.addIceCandidate(iceCandidate);
        }
      },
    };
  },
};

export default class SblClient {
  private ctx: Context;

  constructor() {
    const config: Config = {
      location: { x: 1, y: 2, z: 3 },

      shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

      contracts: [],

      generators: [],

      networkProvider: {
        protocols: new Map(
          Object.entries({
            websocket: websocketProvider,
            webrtc: webrtcProvider,
          }),
        ),
      },

      trustedPeers: [],

      selfPrivateKey: secp.utils.randomPrivateKey(),
      nodeNonce: (new TextEncoder()).encode('browser_0'),
    };

    this.ctx = new Context(config);
    this.ctx.get(SampleContracts).apply({ collatz: false });
    this.ctx.get(EpochContract).apply();
    this.ctx.get(ConnectionService).connect('websocket', 'ws://127.0.0.1:8314');

    let height = 0n;
    setInterval(() => {
      const params = this.ctx.get(EpochContract).makeParams(height++);
      this.ctx.get(QuestionService).getCanonical(
        Hash.fromHex(
          'afc9b31d9f3f3645ae563606e1ddbe4b0e72b247e3bc9dff6251f5ee8961ae48',
        ),
        params,
        (answer) => console.log(answer),
      );
    }, 1000);

    // const params = this.ctx.get(EpochContract).makeParams(10n);
    // this.ctx.get(QuestionService).getCanonical(
    //   Hash.fromHex(
    //     'afc9b31d9f3f3645ae563606e1ddbe4b0e72b247e3bc9dff6251f5ee8961ae48',
    //   ),
    //   params,
    //   (answer) => console.log(answer),
    // );
  }

  public get(
    contractHash: Hash,
    contractParams: Uint8Array,
    onAnswer: (answer: Answer) => void,
  ) {
    this.ctx.get(QuestionService).getCanonical(
      contractHash,
      contractParams,
      onAnswer,
    );
  }

  public close() {}
}

/*
Connected peers & DHT node counts & address
My DHT nodes
All DHT nodes
My DHT entries
All DHT entries
Received SUBs & scores
Sent SUBs & answer(s)
My generators
My SUBs
  Question
  Contract name
  Contract params
  Answer
  Accept collateral (weighted, count)
  Reject collateral (weighted, count)
  My side
  Dupe?


contract (add)
  SUBs
  generators (add)
  question (add)
    SUBs
    answer (add)
      SUBs
      collateral (add)

/contract/[contract hash]

*/

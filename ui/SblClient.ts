import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config, { defaultConfig } from '~/sbl/Config.ts';
import { ConnectionProvider, ProtocolProvider } from '~/sbl/NetworkProvider.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';
import Peer from '~/sbl/Peer.ts';
import Hash from '~/sbl/util/Hash.ts';
import Logger from '~/sbl/Logger.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';
// import DefaultAppraisalProvider from '~/sbl/DefaultAppraisalProvider.ts';

// window['Deno'] = {};

const websocketProvider: ProtocolProvider = {
  createClient: (
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
  createClient: (
    onListen: (spec: string) => void,
    onNewConn: (conn: ConnectionProvider) => void,
  ) => {
    const orderHash = Hash.random();

    let reliableChannel: RTCDataChannel | undefined;
    let fastChannel: RTCDataChannel | undefined;
    const bufferedMsgs: Uint8Array[] = [];
    const isOpen: { [key: string]: boolean } = { reliable: false, fast: false };

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
        close: () => conn.close(),
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
    const setupChannel = (conn: RTCPeerConnection, channel: RTCDataChannel) => {
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

      const config = { iceServers: await iceServersPromise };
      const conn = new RTCPeerConnection(config);

      conn.onicecandidate = (e) =>
        e.candidate && onListen(JSON.stringify({ iceCandidate: e.candidate }));

      return conn;
    })();

    return {
      tryConnect: async (spec: string) => {
        console.log(JSON.parse(spec));

        const { orderHex, offer, answer, iceCandidate } = JSON.parse(spec);
        const conn = await connPromise;

        if (orderHex) {
          const cmp = Hash.cmp(orderHash, Hash.fromHex(orderHex));
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
  },
};

const broadcastProvider: ProtocolProvider = {
  // Use https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
};

export default class SblClient {
  public ctx: Context;

  constructor() {
    const getPrivateKey = () => {
      const pkid = new URLSearchParams(window.location.search).get('pkid') ||
        '';
      const hex = localStorage.getItem(`sbl_pk_${pkid}`);
      if (hex) {
        return hex2bin(hex);
      } else {
        const key = secp.utils.randomPrivateKey();
        localStorage.setItem(`sbl_pk_${pkid}`, bin2hex(key));
        return key;
      }
    };

    const config: Config = {
      ...defaultConfig,

      debugName: 'SblClient',

      log: {
        handler: (
          ctx: Context,
          className: string,
          methodName: string,
          params: Record<string, any>,
        ) =>
          console.log(
            `${className}.${methodName}(${
              this.ctx.get(Logger).serialize(params)
            })`,
          ),
      },

      location: { x: 1, y: 2, z: 3 },

      shouldVerify: (ctx: Context, fromPeer: Peer, pub: any) => true,

      networkProvider: {
        protocols: new Map(Object.entries({
          websocket: websocketProvider,
          webrtc: webrtcProvider,
        })),
      },

      // appraisalProvider: new DefaultAppraisalProvider(),

      trustedPeers: [],

      selfPrivateKey: getPrivateKey(),
      nodeNonce: Hash.random().toBytes(),

      approxComputePricePerSecond: 1000n,

      initialWorkerCount: 16,

      computeContracts: [],
    };

    this.ctx = new Context(config);
    this.ctx.get(ConnectionService).connect('websocket', 'ws://127.0.0.1:8314');

    let height = 0n;
    setInterval(() => {
      // this.ctx.get(QuestionService).getCanonical({
      //   contract_hash: this.ctx.get(EpochContract).get().hash,
      //   params: this.ctx.get(EpochContract).makeParams(height++),
      // }, (answer) => console.log(answer));
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

  // public get(
  //   contractHash: Hash,
  //   contractParams: Uint8Array,
  //   onAnswer: (answer: Answer) => void,
  // ) {
  //   this.ctx.get(QuestionService).getCanonical({
  //     contract_hash: contractHash,
  //     params: contractParams,
  //   }, onAnswer);
  // }

  public close() {
    return this.ctx.destruct();
  }
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

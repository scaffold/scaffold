import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config, { defaultConfig } from '~/sbl/Config.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';
import * as log from 'std-latest/log/mod.ts';
import WebsocketClientProvider from '~/plugins/WebsocketClientProvider.ts';
import WebrtcProvider from '~/plugins/WebrtcProvider.ts';
import LocalStorageProvider from '~/plugins/LocalStorageProvider.ts';
// import DefaultAppraisalProvider from '~/sbl/DefaultAppraisalProvider.ts';

// window['Deno'] = {};

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
      selfPrivateKey: getPrivateKey(),

      logLevel: log.LogLevels.DEBUG,

      networkProvider: {
        protocols: new Map(Object.entries({
          websocket: new WebsocketClientProvider(),
          webrtc: new WebrtcProvider(),
        })),
      },

      storageProvider: new LocalStorageProvider(),
    };

    this.ctx = new Context(config);

    const url = new URL(window.location.href);
    url.protocol = {'http:': 'ws:', 'https:': 'wss:'}[url.protocol]!;
    url.port = '8314';
    this.ctx.get(ConnectionService).connect('websocket', url.origin);

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

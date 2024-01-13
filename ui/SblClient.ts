import secp from '~/sbl/util/secp.ts';
import Context from '~/sbl/Context.ts';
import Config, { defaultNetwork, makeDefaultConfig } from '~/sbl/Config.ts';
import ConnectionService from '~/sbl/ConnectionService.ts';
import { bin2hex, hex2bin } from '~/sbl/util/hex.ts';
import * as log from 'std-latest/log/mod.ts';
import WebsocketClientProvider from '~/plugins/WebsocketClientProvider.ts';
import WebrtcProvider from '~/plugins/WebrtcProvider.ts';
import LocalStorageProvider from '~/plugins/LocalStorageProvider.ts';
import NetworkService from '~/sbl/NetworkService.ts';
import NullStorageProvider from '~/plugins/NullStorageProvider.ts';
// import DefaultAppraisalProvider from '~/sbl/DefaultAppraisalProvider.ts';

// window['Deno'] = {};

const getNetwork = () =>
  new URLSearchParams(window.location.search).get('network') ?? defaultNetwork;

const getPrivateKey = () => {
  const pkid = new URLSearchParams(window.location.search).get('pkid') ?? '';
  const hex = localStorage.getItem(`sbl_pk_${pkid}`);
  if (hex) {
    return hex2bin(hex);
  } else {
    const key = secp.utils.randomPrivateKey();
    localStorage.setItem(`sbl_pk_${pkid}`, bin2hex(key));
    return key;
  }
};

export default class SblClient {
  public ctx: Context;

  constructor() {
    const config: Config = {
      ...makeDefaultConfig(),

      network: getNetwork(),
      debugName: 'SblClient',
      selfPrivateKey: getPrivateKey(),

      logLevel: log.LogLevels.DEBUG,

      networkProviders: [new WebsocketClientProvider(), new WebrtcProvider()],
      // storageProvider: new LocalStorageProvider(),
      storageProvider: new NullStorageProvider(),
      // contractProviders: [],
    };

    this.ctx = new Context(config);

    const url = new URL(window.location.href);
    url.protocol = { 'http:': 'ws:', 'https:': 'wss:' }[url.protocol]!;
    url.port = '8314';
    this.ctx.get(NetworkService).initConnection(
      'websocket@0.0.1',
      hex2bin(
        '024148e8772a0a4ba2b8b4da9b609d224fd82b3cee0e7ea669ee6d7c306d7678e9',
      ),
    ).recvSignal(url.origin);

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

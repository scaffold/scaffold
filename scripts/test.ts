import { WebsocketClientTransport } from '../plugins/WebsocketClientTransport.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { ObjectQuery, Query } from '../src/contract/Query.ts';
import { HELLO_CONTRACT } from '../src/contract/static/Hello.ts';
import { GeneratorRole } from '../src/roles/GeneratorRole.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

const scaffold = new Scaffold({
  ...makeDefaultConfig(),
  roles: [GeneratorRole],
});

scaffold.startTransport(new WebsocketClientTransport(), (signal) => {
  // deno-lint-ignore no-console
  console.log(`WebSocket client announce: ${signal}`);
});

scaffold.connect('ws://127.0.0.1:8314/');

export class HelloContractQuery extends ObjectQuery implements Query {
  constructor(params: { name: string }) {
    super(HELLO_CONTRACT, params);
  }
}

await scaffold.fetch({
  ...new HelloContractQuery({ name: 'Joel' }),
  onResult: (result) => {
    console.log(bin2str(result!.body));
  },
});

// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));

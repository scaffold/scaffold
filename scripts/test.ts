import { WebsocketClientTransport } from '../plugins/WebsocketClientTransport.ts';
import { makeDefaultConfig } from '../src/Config.ts';
import { ObjectQuery, Query } from '../src/contract/Query.ts';
import { HELLO_CONTRACT } from '../src/contract/static/Hello.ts';
import { DraftStore } from '../src/graph/DraftStore.ts';
import { Gossip } from '../src/peer/network/Gossip.ts';
import { GeneratorRole } from '../src/roles/GeneratorRole.ts';
import { Scaffold } from '../src/Scaffold.ts';
import { neverAbort } from '../src/util/abortable.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

const scaffold = new Scaffold({
  ...makeDefaultConfig(),
  roles: [GeneratorRole, Gossip],
});

/*
const draftStore = scaffold.getContext().get(DraftStore);
const draft = draftStore.create();
draftStore.onBuilt(
  draft,
  (block) => console.log(bin2str(block?.raw ?? new Uint8Array())),
  neverAbort,
);
draftStore.build(draft);
*/

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
  onResult: async (result) => {
    console.log(await result!.parse());
    console.log(bin2str(result!.body));
  },
});

// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));

// setTimeout(() => scaffold.close(), 1000);

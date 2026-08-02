import { makeDefaultConfig } from '../src/Config.ts';
import { Context } from '../src/Context.ts';
import { createSource } from '../src/contract/createSource.ts';
import { BinaryContractInputExample, ObjectQuery, Query } from '../src/contract/Query.ts';
import { HELLO_CONTRACT } from '../src/contract/static/Hello.ts';
import { DraftStore } from '../src/graph/DraftStore.ts';
import { Fetch } from '../src/peer/Fetch.ts';
import { Send } from '../src/peer/Send.ts';
import { GeneratorRole } from '../src/roles/GeneratorRole.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

const ctx = new Context(makeDefaultConfig());
ctx.get(GeneratorRole).run();

export class HelloContractQuery extends ObjectQuery implements Query {
  constructor(params: { name: string }) {
    super(HELLO_CONTRACT, params);
  }
}

await ctx.get(Fetch).fetch({
  ...new HelloContractQuery({ name: 'Joel' }),
  onResult: (result) => {
    console.log(bin2str(result!.body));
  },
});

// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));

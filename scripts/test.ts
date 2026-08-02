import { makeDefaultConfig } from '../src/Config.ts';
import { Context } from '../src/Context.ts';
import { BinaryContractInputExample, Query } from '../src/contract/Query.ts';
import { DEMO_CONTRACT } from '../src/contract/static/Demo.ts';
import { DraftStore } from '../src/graph/DraftStore.ts';
import { Fetch } from '../src/peer/Fetch.ts';
import { Send } from '../src/peer/Send.ts';
import { GeneratorRole } from '../src/roles/GeneratorRole.ts';
import { bin2str, str2bin } from '../src/util/buffer.ts';

const ctx = new Context(makeDefaultConfig());
ctx.get(GeneratorRole).run();

ctx.get(Fetch).fetch({
  contract: DEMO_CONTRACT,
  params: str2bin('Joel'),
  onResult: (result) => {
    console.log(result, bin2str(result!.body));
  },
});

// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));
// ctx.get(DraftStore).build(ctx.get(DraftStore).create({}));

import { WorkerChannelClient } from './WorkerChannel.ts';
import { makeClientUtils } from '~/sbl/worker/clientUtils.ts';
import { JobMessage, WorkerComm } from './workerTypes.ts';

export default async (
  client: WorkerChannelClient<WorkerComm>,
  { code, contractHash, params, emitCorrect }: JobMessage,
) => {
  const clientUtils = makeClientUtils(client);

  // const code = handler(
  //   Hash.fromBytes(codeVerifier.contractHash),
  //   codeVerifier.params,
  // );
  const func = eval(new TextDecoder().decode(code));
  if (typeof func !== 'function') {
    throw new Error(`Script is not a function`);
  }
  const out: Uint8Array = await func(
    contractHash,
    params,
    emitCorrect,
    clientUtils.request,
    clientUtils.notify,
  );

  clientUtils.returnResult(out);
};

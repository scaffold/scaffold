import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobSpec, WorkerComm } from './workerTypes.ts';
import { Instance } from './Instance.ts';
import { mapPut } from '../util/map.ts';

console.log('Worker starting...');

let client: WorkerChannelClient<WorkerComm> | undefined;

const instances = new Map<number, Instance>();
const getInstance = (instanceId: number) =>
  mapPut(instances, instanceId, () => {
    if (client === undefined) {
      throw new Error('No client set!');
    }
    return new Instance(client.createChannel(instanceId));
  });

self.onmessage = async (msg: MessageEvent<JobSpec>) => {
  try {
    switch (msg.data.type) {
      case 'init':
        client = new WorkerChannelClient<WorkerComm>(self, msg.data.sigBuf);
        break;

      case 'instantiate_wasm':
        await getInstance(msg.data.instanceId).instantiate(msg.data);
        break;

      case 'call_method':
        getInstance(msg.data.instanceId).call(msg.data);
        break;

      case 'exit':
        self.close();
        break;
    }
  } catch (err) {
    console.error(err);
  }
};

console.log('Worker finished!');

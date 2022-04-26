import { WorkerChannelClient } from './WorkerChannel.ts';
import { JobSpec, WorkerComm } from './workerTypes.ts';
import execJob from './execJob.ts';

console.log('Worker starting...');

const msg = await new Promise<MessageEvent<any>>((resolve) =>
  self.onmessage = resolve
);
const { sigBuf } = msg.data;

const client = new WorkerChannelClient<WorkerComm>(self, sigBuf);

while (true) {
  console.log('Worker is ready...');
  client.inform('ready', [], []);
  const msg = await new Promise<MessageEvent<JobSpec>>((resolve) =>
    self.onmessage = resolve
  );

  if (msg.data) {
    console.log('Worker received job...');
    await execJob(client, msg.data);
  } else {
    break;
  }
}

client.inform('exit', [], []);
console.log('Worker finished!');

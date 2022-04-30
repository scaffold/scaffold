import { WorkerChannelClient } from './WorkerChannel.ts';
import { InitialMessage, JobMessage, WorkerComm } from './workerTypes.ts';
import execJob from './execJob.ts';

console.log('Worker starting...');

const msg = await new Promise<MessageEvent<InitialMessage>>((resolve) =>
  self.onmessage = resolve
);
const { sigBuf } = msg.data;

console.log('postMessage', self.postMessage.toString());
const client = new WorkerChannelClient<WorkerComm>(self, sigBuf);

while (true) {
  console.log('Worker is ready...');
  client.inform('ready', [], []);
  const msg = await new Promise<MessageEvent<JobMessage>>((resolve) =>
    self.onmessage = resolve
  );

  if (msg.data) {
    console.log('Worker received job...');
    await execJob(client, msg.data).catch((err) => console.error(err));
  } else {
    break;
  }
}

client.inform('exit', [], []);
console.log('Worker finished!');

import { LoggingProvider } from '../src/interfaces/LoggingProvider.ts';
import { LogEvent } from '../src/interfaces/logging.ts';
import { str2bin } from '../src/util/buffer.ts';
import { assert } from '../src/util/functional.ts';
import { jsonSafeStringify } from '../src/util/json.ts';
import { isUnshared } from './util.ts';

export class WebsocketLoggingProvider implements LoggingProvider {
  private ws: WebSocket;
  private queue?: Uint8Array[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const payload of this.queue ?? []) {
        assert(isUnshared(payload));
        this.ws.send(payload);
      }
      this.queue = undefined;
    };
  }

  handler(event: LogEvent, ctx: { config: { debugName: string } }) {
    const packet = str2bin(
      jsonSafeStringify({
        source: ctx.config.debugName,
        ...event,
        timestamp: new Date(event.timestamp).toISOString(),
      }) + '\n',
    );

    if (this.queue === undefined) {
      assert(isUnshared(packet));
      this.ws.send(packet);
    } else {
      this.queue.push(packet);
    }
  }
}

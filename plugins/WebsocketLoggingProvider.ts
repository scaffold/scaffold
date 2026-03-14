import { LoggingProvider } from '../src/interfaces/LoggingProvider.ts';
import { LogEvent } from '../src/interfaces/logging.ts';
import { str2bin } from '../src/util/buffer.ts';
import { jsonSafeStringify } from '../src/util/json.ts';

export class WebsocketLoggingProvider implements LoggingProvider {
  private ws: WebSocket;
  private queue?: Uint8Array[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      for (const payload of this.queue ?? []) {
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
      this.ws.send(packet);
    } else {
      this.queue.push(packet);
    }
  }
}

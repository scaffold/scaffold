import { LoggingProvider } from '../src/Config.ts';
import { LogEvent } from '../src/Logger.ts';
import { str2bin } from '../src/util/buffer.ts';

export class WebsocketLoggingProvider implements LoggingProvider {
  private ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
  }

  handler(event: LogEvent) {
    this.ws.send(str2bin(JSON.stringify({
      ...event,
      timestamp: new Date(event.timestamp).toISOString(),
    })));
  }
}

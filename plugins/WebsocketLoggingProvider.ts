import { LogEvent, LoggingProvider, LogLevel } from '../src/interfaces/LoggingProvider.ts';
import { str2bin } from '../src/util/buffer.ts';
import { assert } from '../src/util/functional.ts';
import { jsonSafeStringify } from '../src/util/json.ts';
import { LevelFn, toLevelFn } from './logSpec.ts';
import { isUnshared } from './util.ts';

/** Newline-delimited JSON over a socket; buffers until the socket opens. */
export class WebsocketLoggingProvider implements LoggingProvider {
  private ws: WebSocket;
  private queue?: Uint8Array[] = [];
  private levelFn: LevelFn;

  constructor(url: string, opts?: { source?: string; level?: string | LevelFn }) {
    this.levelFn = toLevelFn(opts?.level ?? 'debug');
    this.source = opts?.source;
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

  private source?: string;

  level(system: string): LogLevel | undefined {
    return this.levelFn(system);
  }

  handle(event: LogEvent): void {
    const packet = str2bin(
      jsonSafeStringify({
        source: this.source,
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

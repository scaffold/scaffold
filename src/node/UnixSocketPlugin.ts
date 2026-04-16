import { NetworkDriver, NetworkPlugin } from './NetworkManager.ts';
import { TransportConnection } from './PeerConnection.ts';

/**
 * Network plugin that uses Unix domain sockets for P2P communication.
 *
 * Each plugin instance listens on a unique socket path (default:
 * /tmp/scaffold-<uuid>.sock). Peers connect by passing the remote socket
 * path to connect().
 *
 * Wire format uses length-prefixed binary framing (4-byte big-endian
 * length header + payload) so it works unchanged when the transport
 * switches from string to binary serialization.
 */
export class UnixSocketPlugin implements NetworkPlugin {
  private listener?: Deno.Listener;
  private driver?: NetworkDriver;
  private readonly activeConns = new Set<Deno.Conn>();
  readonly socketPath: string;

  constructor(socketPath?: string) {
    this.socketPath = socketPath ?? `/tmp/scaffold-${crypto.randomUUID()}.sock`;
  }

  start(driver: NetworkDriver): void {
    this.driver = driver;
    this.listener = Deno.listen({ path: this.socketPath, transport: 'unix' });
    this.acceptLoop();
  }

  connect(address: string): void {
    Deno.connect({ path: address, transport: 'unix' }).then(
      (conn) => {
        this.addConn(conn);
      },
      () => {
        // connection failed -- nothing to do
      },
    );
  }

  stop(): void {
    try {
      this.listener?.close();
    } catch { /* already closed */ }
    for (const conn of this.activeConns) {
      try {
        conn.close();
      } catch { /* already closed */ }
    }
    this.activeConns.clear();
    try {
      Deno.removeSync(this.socketPath);
    } catch { /* ok if already gone */ }
  }

  // -- Internal -----------------------------------------------------------

  private async acceptLoop(): Promise<void> {
    if (!this.listener) return;
    try {
      for await (const conn of this.listener) {
        this.addConn(conn);
      }
    } catch {
      // listener closed
    }
  }

  private addConn(conn: Deno.Conn): void {
    this.activeConns.add(conn);
    const peerId = `unix:${crypto.randomUUID().slice(0, 8)}`;
    const transport = wrapConnection(conn, peerId, () => {
      this.activeConns.delete(conn);
    });
    this.driver?.onConnection(transport);
  }
}

// -- Length-prefixed framing ----------------------------------------------

/**
 * Wrap a raw Deno.Conn in a TransportConnection with length-prefixed
 * binary framing.
 *
 * Wire format per message:
 *   [4 bytes big-endian length][N bytes payload]
 *
 * The send() interface is synchronous (matching TransportConnection), so
 * writes are queued and drained asynchronously to maintain ordering.
 */
function wrapConnection(
  conn: Deno.Conn,
  peerId: string,
  onCleanup: () => void,
): TransportConnection {
  const handlers = {
    message: null as ((data: string) => void) | null,
    close: null as (() => void) | null,
  };
  let closed = false;

  // -- Write queue --------------------------------------------------------

  const writeQueue: Uint8Array[] = [];
  let draining = false;

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (writeQueue.length > 0 && !closed) {
        const frame = writeQueue.shift()!;
        await writeAll(conn, frame);
      }
    } catch {
      doClose();
    }
    draining = false;
  }

  // -- Close --------------------------------------------------------------

  function doClose(): void {
    if (closed) return;
    closed = true;
    try {
      conn.close();
    } catch { /* already closed */ }
    onCleanup();
    handlers.close?.();
  }

  // -- Read loop ----------------------------------------------------------

  (async () => {
    const headerBuf = new Uint8Array(4);
    try {
      while (!closed) {
        if (!await readFull(conn, headerBuf)) break;
        const len = new DataView(headerBuf.buffer).getUint32(0);
        const payload = new Uint8Array(len);
        if (!await readFull(conn, payload)) break;
        handlers.message?.(new TextDecoder().decode(payload));
      }
    } catch {
      // connection error
    }
    doClose();
  })();

  // -- TransportConnection ------------------------------------------------

  const encoder = new TextEncoder();

  return {
    peerId,
    send(data: string): void {
      if (closed) return;
      const payload = encoder.encode(data);
      const frame = new Uint8Array(4 + payload.byteLength);
      new DataView(frame.buffer).setUint32(0, payload.byteLength);
      frame.set(payload, 4);
      writeQueue.push(frame);
      drain();
    },
    onMessage(handler: (data: string) => void): void {
      handlers.message = handler;
    },
    onClose(handler: () => void): void {
      handlers.close = handler;
    },
    close(): void {
      doClose();
    },
  };
}

// -- Helpers --------------------------------------------------------------

async function readFull(conn: Deno.Conn, buf: Uint8Array): Promise<boolean> {
  let offset = 0;
  while (offset < buf.byteLength) {
    const n = await conn.read(buf.subarray(offset));
    if (n === null) return false;
    offset += n;
  }
  return true;
}

async function writeAll(conn: Deno.Conn, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const n = await conn.write(data.subarray(offset));
    offset += n;
  }
}

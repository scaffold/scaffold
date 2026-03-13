import { BlockPayload } from '../core/Block.ts';
import { parsePacket } from '../core/Packet.ts';
import { DemoNode } from './DemoNode.ts';

/**
 * Start a WebSocket server for a DemoNode.
 * Peers connect to ws://localhost:{port} and exchange raw packets.
 */
export function startServer(node: DemoNode, port: number): Deno.HttpServer {
  return Deno.serve({ port, onListen: () => {} }, (req) => {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 400 });
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const peerId = `incoming:${port}:${crypto.randomUUID().slice(0, 8)}`;

    socket.onopen = () => {
      node.addPeer(peerId, socket);
    };

    socket.onmessage = (event) => {
      handleMessage(node, peerId, event.data);
    };

    socket.onclose = () => {
      node.removePeer(peerId);
    };

    socket.onerror = () => {
      node.removePeer(peerId);
    };

    return response;
  });
}

/**
 * Connect a DemoNode to a peer's WebSocket server.
 */
export function connectToPeer(node: DemoNode, port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.binaryType = 'arraybuffer';
    const peerId = `outgoing:${port}`;

    ws.onopen = () => {
      node.addPeer(peerId, ws);
      resolve(ws);
    };

    ws.onmessage = (event) => {
      handleMessage(node, peerId, event.data);
    };

    ws.onclose = () => {
      node.removePeer(peerId);
    };

    ws.onerror = (err) => {
      node.removePeer(peerId);
      reject(err);
    };
  });
}

/** Handle an incoming raw packet message. */
function handleMessage(node: DemoNode, peerId: string, data: unknown): void {
  try {
    let raw: Uint8Array;
    if (data instanceof ArrayBuffer) {
      raw = new Uint8Array(data);
    } else if (data instanceof Uint8Array) {
      raw = data;
    } else {
      return; // Ignore non-binary messages
    }

    const packet = parsePacket<BlockPayload>(raw);
    if (!packet) return;

    node.receivePacket(packet, peerId);
  } catch {
    // Ignore malformed messages
  }
}

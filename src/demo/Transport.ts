import { Block } from '../Block.ts';
import { deserialize } from '../BlockSerializer.ts';
import { DemoNode, WireMessage, base64ToUint8 } from './DemoNode.ts';
import { SignedBlock } from './SignedBlock.ts';

/**
 * Start a WebSocket server for a DemoNode.
 * Peers connect to ws://localhost:{port} and exchange signed blocks.
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
      handleMessage(node, peerId, event.data as string);
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
    const peerId = `outgoing:${port}`;

    ws.onopen = () => {
      node.addPeer(peerId, ws);
      resolve(ws);
    };

    ws.onmessage = (event) => {
      handleMessage(node, peerId, event.data as string);
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

/** Handle an incoming wire message. */
function handleMessage(node: DemoNode, peerId: string, raw: string): void {
  try {
    const msg: WireMessage = JSON.parse(raw);
    if (msg.type !== 'block') return;

    const block = deserialize<Block>(msg.data);
    const signature = base64ToUint8(msg.signature);
    const sb: SignedBlock = { block, signature };

    node.receiveSignedBlock(sb, peerId);
  } catch {
    // Ignore malformed messages
  }
}

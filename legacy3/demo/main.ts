import { AnimalName, ANIMALS } from './Identity.ts';
import { DemoNode } from './DemoNode.ts';
import { connectToPeer, startServer } from './Transport.ts';

// -- Argument parsing --

function parseArgs(): { identity: AnimalName; port: number } {
  const args = Deno.args;
  let identity: AnimalName | undefined;
  let port: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--identity' && i + 1 < args.length) {
      const name = args[i + 1] as AnimalName;
      if (!ANIMALS.includes(name)) {
        console.error(`Unknown identity: ${name}. Valid: ${ANIMALS.join(', ')}`);
        Deno.exit(1);
      }
      identity = name;
      i++;
    } else if (args[i] === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1]);
      if (isNaN(port)) {
        console.error(`Invalid port: ${args[i + 1]}`);
        Deno.exit(1);
      }
      i++;
    }
  }

  if (!identity) {
    console.error('Usage: --identity <animal> --port <number>');
    console.error(`Animals: ${ANIMALS.join(', ')}`);
    Deno.exit(1);
  }

  if (!port) {
    console.error('Usage: --identity <animal> --port <number>');
    Deno.exit(1);
  }

  return { identity, port };
}

// -- JSON output --

function emit(node: DemoNode, event: Record<string, unknown>): void {
  const line = JSON.stringify({
    ...event,
    peers: node.peerCount,
    balance: 1, // always 1 in this demo (each identity has exactly one status output)
  });
  console.log(line);
}

// -- Main --

async function main(): Promise<void> {
  const { identity, port } = parseArgs();

  const node = new DemoNode(identity);
  startServer(node, port);

  emit(node, { type: 'started', identity, port });

  // Subscribe to status changes and emit events
  node.statusIndex.setOnStatusChange((name, message) => {
    emit(node, { type: 'status_change', identity: name, message });
  });

  // Read commands from stdin
  const reader = Deno.stdin.readable
    .pipeThrough(new TextDecoderStream());

  let buffer = '';
  for await (const chunk of reader) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0];

      switch (cmd) {
        case 'connect': {
          const targetPort = parseInt(parts[1]);
          if (isNaN(targetPort)) {
            emit(node, { type: 'error', message: 'usage: connect <port>' });
            break;
          }
          try {
            await connectToPeer(node, targetPort);
            emit(node, { type: 'connected', port: targetPort });
          } catch (err) {
            emit(node, { type: 'error', message: `connect failed: ${err}` });
          }
          break;
        }

        case 'sub': {
          const name = parts[1] as AnimalName;
          if (!ANIMALS.includes(name)) {
            emit(node, { type: 'error', message: `unknown identity: ${parts[1]}` });
            break;
          }
          node.statusIndex.subscribe(name);
          emit(node, { type: 'subscribed', identity: name });
          break;
        }

        case 'unsub': {
          const name = parts[1] as AnimalName;
          if (!ANIMALS.includes(name)) {
            emit(node, { type: 'error', message: `unknown identity: ${parts[1]}` });
            break;
          }
          node.statusIndex.unsubscribe(name);
          emit(node, { type: 'unsubscribed', identity: name });
          break;
        }

        case 'pub': {
          const targetName = parts[1] as AnimalName;
          if (!ANIMALS.includes(targetName)) {
            emit(node, { type: 'error', message: `unknown identity: ${parts[1]}` });
            break;
          }
          const message = parts.slice(2).join(' ');
          try {
            node.publishStatus(targetName, message);
            emit(node, { type: 'published', identity: targetName, message });
          } catch (e) {
            emit(node, {
              type: 'publish_error',
              identity: targetName,
              message,
              error: (e as Error).message,
            });
          }
          break;
        }

        case 'status': {
          const statuses: Record<string, string> = {};
          for (const [name, msg] of node.statusIndex.getAllStatuses()) {
            if (msg !== '') statuses[name] = msg;
          }
          emit(node, { type: 'statuses', statuses });
          break;
        }

        default:
          emit(node, { type: 'error', message: `unknown command: ${cmd}` });
      }
    }
  }
}

main();

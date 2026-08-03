import { ConnectionProvider } from '../../interfaces/transport.ts';
import { MessageJoiner, MessageSplitter } from './MessageSplitter.ts';

export interface Connection {
  // Log label only. The Connection object itself is the identity everywhere else.
  debugName: string;

  isOpen: boolean;

  provider: ConnectionProvider;
  splitter: MessageSplitter;
  joiner: MessageJoiner;

  // Bound for authenticated connections; undefined while a connection is anonymous.
  remotePublicKey?: Uint8Array;

  sentCount: number;
  recvCount: number;
}

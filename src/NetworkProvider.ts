import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';

export interface NetworkProvider {
  readonly providesProtocol: string;
  readonly connectsToProtocols?: string[];

  createInstance(driver: SignalingDriver): SignalingProvider;
}

export interface SignalingDriver {
  ctx: Context;

  protocol: string;
  isInitiator: boolean; // TODO: Fix this property - it isn't set correctly for some reason.
  myToken?: Hash;

  sendSignal(signal: string, priority?: number): void;
  createConnection(remoteToken: Hash | undefined, conn: ConnectionProvider): ConnectionDriver;
}

export interface SignalingProvider {
  recvSignal(signal: string, orderIdx: number): void;
  dispose?(): void;
}

export interface ConnectionProvider {
  // Does not need to maintain order between sends, but does need to make sure packet's aren't dropped or mangled.
  // TODO: Should we require ordering?
  sendReliable(data: Uint8Array): void;

  // Just send it fast. No worries if it drops.
  sendFast(data: Uint8Array): void;

  shutdown(): void;
}

export interface ConnectionDriver {
  recvData(data: Uint8Array): void;

  // Call this handler when the transport closes
  close(): void;
}

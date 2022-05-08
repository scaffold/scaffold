import { Connection } from './ConnectionService.ts';
import { Packet } from './messages.ts';
import Hash from './util/Hash.ts';

export default interface MessageCtx {
  conn: Connection;
  packet: Packet;
  signature: Uint8Array;
  msgData: Uint8Array;
  msgHash: Hash;
  packetData: Uint8Array;
}

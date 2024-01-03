import { FactBase, FactSource, FactType, SignalFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import { Signal } from '~/sbl/messages.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import KeyService from '~/sbl/KeyService.ts';
import FactService from '~/sbl/FactService.ts';
import NodeService from '~/sbl/NodeService.ts';
import ClockService from '~/sbl/ClockService.ts';
import { mapPut } from '~/sbl/util/map.ts';
import { arrPut } from '~/sbl/util/array.ts';
import { ConnectionProvider } from '~/sbl/NetworkProvider.ts';

interface Connection {
  publicKey: Uint8Array;
  nextSignalIdx: number;
  signalBuffer: (string | undefined)[];
  provider: ConnectionProvider;
}

export default class ConnectionService2 {
  private connections = new Map<HashPrimitive, Connection>();

  constructor(private ctx: Context) {
  }

  public recvSignal(signal: SignalFact) {
    const conn = this.getConnection(signal);
    if (signal.signal_index >= 0) {
      conn.signalBuffer[signal.signal_index] = signal.signal_data;
      while (conn.signalBuffer[conn.nextSignalIdx] !== undefined) {
        this.dispatchSignal(conn.signalBuffer[conn.nextSignalIdx]);
        conn.nextSignalIdx++;
      }
    }
  }

  private getConnection(signal: SignalFact): Connection {
    const publicKey = this.ctx.get(FactService).getPublicKey(signal);
    const connHash = Hash.digestParts(
      publicKey,
      signal.connection_nonce,
      signal.protocol_name,
    );
    return mapPut(
      this.connections,
      connHash.toPrimitive(),
      () => ({ publicKey, nextSignalIdx: 0, signalBuffer: [] }),
    );
  }
}

import { SignalFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import FactService from '~/sbl/FactService.ts';
import { mapPut } from '~/sbl/util/map.ts';
import { SignalingProvider } from '~/sbl/NetworkProvider.ts';
import NetworkService from '~/sbl/NetworkService.ts';
import SignalingService from '~/sbl/SignalingService.ts';

interface Connection {
}

export default class ConnectionService2 {
  private connections = new Map<HashPrimitive, Connection>();

  constructor(private ctx: Context) {}
}

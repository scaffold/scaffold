import { SignalFact } from '~/sbl/FactMeta.ts';
import Context from '~/sbl/Context.ts';
import Hash, { HashPrimitive } from '~/sbl/util/Hash.ts';
import FactService from '~/sbl/FactService.ts';
import { mapPut } from '~/sbl/util/map.ts';
import { SignalingProvider } from '~/sbl/NetworkProvider.ts';
import NetworkService from '~/sbl/NetworkService.ts';
import SignalingService from '~/sbl/SignalingService.ts';

interface Connection {
  // Altruism increases when we recieve helpful facts from the node
  // Altruism decreases when we send (hopefully helpful) facts to the node
  // We publish to positively altruistic nodes
  altruism: number;
}

export default class ConnectionService2 {
  private connections = new Map<HashPrimitive, Connection>();

  constructor(private ctx: Context) {}
}

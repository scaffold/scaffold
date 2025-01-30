import { Connection } from './Connection.ts';
import { FingerprintSet } from './FingerprintSet.ts';

export class RoutingService {
  // Note that distinct connections with the same publicKey+nonce combo will have the same FingerprintSet.
  private knownFacts = new Map<Connection, FingerprintSet>();
}

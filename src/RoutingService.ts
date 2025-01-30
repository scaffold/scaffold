import { Connection } from './ConnectionService.ts';
import { FingerprintSet } from './FingerprintSet.ts';

// JUST USE A HASH SET FOR NOW

export class RoutingService {
  // Note that distinct connections with the same publicKey+nonce combo will have the same FingerprintSet.
  private knownFacts = new Map<Connection, FingerprintSet>();
}

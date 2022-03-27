import Hash from './util/Hash.ts';

export default interface Peer {
  publicKey: Uint8Array;

  meta: {
    name?: string;
    implName?: string;
    protocolVersion?: number;
    proofOfAge?: Uint8Array;
  };

  trust: number;
}

// A single peer could be active on multiple computers (ConnectionSpecs), or a single connection could possess the ability to sign for multiple peers, so there's not really a relationship.

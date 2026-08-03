export class MeshBase {
  connect(publicKey: Uint8Array): void {
    // Go through all plugins with non-undefined emitsProtocol
    // Call initializeAuthenticatedTransport if undefined
    // Plugin sends signals
    // Scaffold groups signals (or an empty array) and sends packets to remote peer
    // Either way (empty array or not), this tells the remote peer that someone is trying to connect
    // If the remote peer can, it will respond with its own grouped signal packets
    // Plugin sends and recieves signals; scaffold handles grouping and routing
    // Eventually a number of connections are established
    // Signals to/from peers with connections already established are deprioritized
    // Multiple connections to the same peer are ok; they are equivalent to connections to multiple servers running on the same remote machine
    // They should be treated in the same way, and judged relative to other connections
    // If useful bandwidth is too low, eliminate one
    // Or maybe after a minute of double-connections to a single public key, eliminate the lowest-performing one
  }
}

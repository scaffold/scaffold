# Plan: Peer Module

## Goal
Manage peer discovery, connection scoring, and disconnection of unproductive peers.

## What Exists
- GossipModule exports `getGossipQuality(peer)`, `getReciprocity(peer)`, `getBandwidthBudget(peer)`
- NetworkManager tracks connected peers
- PeerConnection supports peerInfo messages (contracts list)

## What Needs to Be Done

1. **PeerModule class**: Owns the peer set and makes connection decisions
   - `evaluatePeers()` — score all peers, disconnect worst, connect to new
   - `onPeerDiscovered(address)` — consider connecting
   - `maxPeers`, `minPeers`, `evaluationInterval` config

2. **Discovery mechanisms**:
   - Bootstrap list (hardcoded addresses)
   - Peer exchange (ask connected peers for their peers)
   - Optional DHT for larger networks

3. **Scoring**: Combine gossip quality, reciprocity, latency, uptime

4. **Churn handling**: Reconnect on disconnect, backoff on repeated failures

## Open Questions
See docs/questions.md — discovery mechanism choice, scoring formula.

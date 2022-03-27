const NUM_PEERS = 10;

const contracts: {
  name: string;
  func(param: number, request: (name: string, param: number) => void): void;
}[] = [
  {
    name: 'epoch',
    func: (param: number, request: (name: string, param: number) => void) => {
      if (param) {
        request('epoch', param - 1);
      }
    },
  },
];

interface Vertex {
  id: string;
  inputs: { id: string }[];
}

interface OrderProof {
  sequence: Vertex[];
}

interface TimeDistribution {
  latestTime: number;
}

interface Message {
  vertex: Vertex;
}

const getOrCreate = <K, V>(map: Map<K, V>, key: K, creator: () => V) => {
  let val = map.get(key);
  if (!val) {
    val = creator();
    map.set(key, val);
  }
  return val;
};

class Peer {
  public x: number;
  public y: number;
  public z: number;

  public conns: { peer: Peer; send(data: Message): void }[] = [];

  public vertices: Map<string, { vertex: Vertex; time: TimeDistribution }> =
    new Map();

  constructor() {
    const x = Math.random() * 2 - 1;
    const y = Math.random() * 2 - 1;
    const z = Math.random() * 2 - 1;
    const d = Math.sqrt(x * x + y * y + z * z);
    this.x = x / d;
    this.y = y / d;
    this.z = z / d;

    /*
    Peers build on the chain that the network will agree on (usually the first). Incentive to include current longest chain. Commitments include parent so they can’t be reordered.
    The problem is someone could distribute some long chain that remotely includes an alternate commitment chain, and get it mixed in. Then, they can present a proof that the alternate chain is canonical.
    This is fixed by: Ordering of answers is specified by the FIRST DERIVED ANSWER THAT INCLUDES BOTH.
    Worst case: Two alternate parallel chains. Eventually, when mixed, one will be chosen. If I’m building on one that has a lower chance of being chosen, I want to switch.
    Need to do a simulation that sees if this converges.
    Which ML models to predict the chosen answer make it converge the fastest?
    This is great. This defines an answer ordering. Canonical answers can be chosen, and voting performed.
    */
  }

  public connect(peer: Peer, distance: number) {
    if (this.conns.every((c) => c.peer !== peer)) {
      const delay = distance * 1000 * (Math.random() + 1);

      this.conns.push({
        peer,
        send: (data: Message) => setTimeout(() => peer.recv(this, data), delay),
      });
    }
  }

  public recv(from: Peer, msg: Message) {
    const vertex = getOrCreate(
      this.vertices,
      msg.vertex.id,
      () => ({ vertex: msg.vertex, time: { latestTime: Infinity } }),
    );
    vertex.time.latestTime = Math.min(vertex.time.latestTime, Date.now());
  }
}

const peers: Peer[] = [];
for (let i = 0; i < NUM_PEERS; i++) {
  peers.push(new Peer());
}

peers.map((p) => {
  peers.map((q) => ({
    q,
    d: Math.pow(p.x - q.x, 2) + Math.pow(p.y - q.y, 2) + Math.pow(p.z - q.z, 2),
  })).sort((a, b) => a.d - b.d).slice(0, 4).forEach(({ q, d }) => {
    q.connect(p, d);
    p.connect(q, d);
  });
});

peers[0].conns;

import { Node } from './NodeService.ts';
import { Context } from './Context.ts';
import { Hash } from './util/Hash.ts';

const maxBucketEntries = 10;

export interface DhtEntry {
  answer: Hash;
  node: Node;
}

export class DhtTable {
  private buckets: DhtEntry[][] = [...new Array(257)].map(() => []);

  constructor(private ctx: Context, public centerHash: Hash) {}

  public add(entry: DhtEntry) {
    const bucket = this.getBucketFor(entry.answer);
    bucket.push(entry);

    // TODO: Better removing; remove high-latency peers or low-trust peers. Should not ever remove a bootstrap peer?
    if (bucket.length > maxBucketEntries) {
      bucket.shift();
    }
  }

  public remove(entry: DhtEntry) {
    const bucket = this.getBucketFor(entry.answer);
    const idx = bucket.findIndex(({ answer }) =>
      Hash.equals(answer, entry.answer)
    );
    if (idx !== -1) {
      bucket.splice(idx, 1);
    }
  }

  private getBucketFor(key: Hash) {
    const bucketIdx = Hash.xor(this.centerHash, key).countLeadingZeros();
    return this.buckets[bucketIdx];
  }

  // private scorePeer(peer:)

  public forEach(cb: (entry: DhtEntry) => void) {
    for (const bucket of this.buckets) {
      for (const entry of bucket) {
        cb(entry);
      }
    }
  }
}

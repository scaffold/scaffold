import { Context } from '../Context.ts';
import { BlockStore } from '../graph/BlockStore.ts';
import { AtomSource } from '../graph/types.ts';
import { ExecutionQueue } from '../peer/ExecutionQueue.ts';
import { Transport } from '../peer/network/Transport.ts';
import { arrCall } from '../util/array.ts';
import { assert } from '../util/functional.ts';
import { JobState, RunQueue } from '../util/RunQueue.ts';

export interface Metrics {
  // Connection metrics
  seenPeers: number;
  connectedPeers: number;
  connectedPeersByPlugin: Record<string, number>;

  // Job queue metrics
  jobsPending: number;
  jobsYielding: number;
  jobsRunning: number;
  jobsCompleted: number;
  jobsRemoved: number;

  // Contract execution metrics
  blocksGenerated: number;
  blocksVerified: number;

  // Network bandwidth metrics
  blocksReceived: number;
  bytesReceived: number;

  // Global graph metrics
  totalDagOutputs: number;

  // Local coin metrics
  coinsEarned: bigint;
  coinsSpent: bigint;
}
type MetricKeys<T> = { [K in keyof Metrics]: Metrics[K] extends T ? K : never }[keyof Metrics];

export class MetricsRole {
  private listeners = new Set<(metrics: Metrics) => void>();
  private disposeController = new AbortController();

  private metrics: Metrics = {
    // Connection metrics
    seenPeers: 0,
    connectedPeers: 0,
    connectedPeersByPlugin: {},

    // Job queue metrics
    jobsPending: 0,
    jobsYielding: 0,
    jobsRunning: 0,
    jobsCompleted: 0,
    jobsRemoved: 0,

    // Contract execution metrics
    blocksGenerated: 0,
    blocksVerified: 0,

    // Network bandwidth metrics
    blocksReceived: 0,
    bytesReceived: 0,

    // Global graph metrics
    totalDagOutputs: 0,

    // Local coin metrics
    coinsEarned: 0n,
    coinsSpent: 0n,
  };

  constructor(private ctx: Context) {
    const signal = this.disposeController.signal;

    ctx.onConstruct(Transport, (transport) => {
      transport.onConnection((conn) => {
        this.metrics.seenPeers++;
        this.metrics.connectedPeers++;
        this.metrics.connectedPeersByPlugin[conn.pluginName]++;
        this.callListeners();
      }, signal);

      transport.onClosed((conn) => {
        this.metrics.connectedPeers--;
        this.metrics.connectedPeersByPlugin[conn.pluginName]--;
        this.callListeners();
      }, signal);

      transport.onData((_conn, data) => {
        this.metrics.bytesReceived += data.byteLength;
        this.callListeners();
      }, signal);
    }, signal);

    ctx.onConstruct(ExecutionQueue, (queue) => {
      queue.onCounts((counts) => {
        this.metrics.jobsPending = counts[JobState.Pending];
        this.metrics.jobsYielding = counts[JobState.Yielding];
        this.metrics.jobsRunning = counts[JobState.Running];
        this.metrics.jobsCompleted = counts[JobState.Completed];
        this.metrics.jobsRemoved = counts[JobState.Removed];
        this.callListeners();
      }, signal);
    }, signal);

    ctx.onConstruct(BlockStore, (store) => {
      store.onIngest(
        (block) => {
          if (block.source === AtomSource.Local) this.metrics.blocksGenerated++;
          else if (block.source === AtomSource.Remote) this.metrics.blocksReceived++;
          this.callListeners();
        },
        signal,
      );
    }, signal);
  }

  [Symbol.dispose]() {
    this.disposeController.abort();
  }

  onMetrics(cb: (metrics: Metrics) => void, signal?: AbortSignal) {
    if (signal?.aborted) return;
    this.listeners.add(cb);
    signal?.addEventListener('abort', () => assert(this.listeners.delete(cb)));
  }

  private callListeners() {
    arrCall(this.listeners, this.metrics);
  }
}

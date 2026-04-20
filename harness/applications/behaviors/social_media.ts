#!/usr/bin/env -S deno run --allow-all
/**
 * Social-media session simulation.
 *
 * Simulates a user scrolling a feed: at randomized intervals, "view" a
 * post by fetching the latest signature output of a randomly-chosen
 * peer. Exits when the session duration elapses or SIGTERM arrives.
 *
 * Params (in YAML application.params):
 *   scrollIntervalMs  -- { mean, stddev } Gaussian sleep between scrolls
 *   feedSize          -- total scrolls to perform before idling
 *   peerMigrationRate -- probability per scroll of dropping current
 *                        "followed" peer and picking a new one
 */

import { type AppContext, runApplication } from '../App.ts';
import { gaussian } from '../../rand.ts';

interface Params {
  scrollIntervalMs?: { mean: number; stddev: number };
  feedSize?: number;
  peerMigrationRate?: number;
}

runApplication(async (ctx: AppContext) => {
  const p = ctx.params as Params;
  const interval = p.scrollIntervalMs ?? { mean: 2000, stddev: 400 };
  const feedSize = p.feedSize ?? 200;
  const migrationRate = p.peerMigrationRate ?? 0.05;

  let currentFollowed: string | null = null;

  const pickFollowed = (): string | null => {
    const all = ctx.directory.snapshot();
    const mine = ctx.scaffold.publicKeyHex;
    const others = all.filter((p) => p.pubkeyHex !== mine);
    if (others.length === 0) return null;
    const idx = Math.floor(ctx.random() * others.length);
    return others[idx].pubkeyHex;
  };

  ctx.log('feed_session_start', { feedSize, interval });

  for (let scroll = 0; scroll < feedSize; scroll++) {
    if (ctx.shouldStop()) break;

    if (!currentFollowed || ctx.random() < migrationRate) {
      const next = pickFollowed();
      if (next && next !== currentFollowed) {
        ctx.log('peer_migration', { from: currentFollowed, to: next });
        currentFollowed = next;
      }
    }

    if (currentFollowed) {
      // V1: simulate a feed view by emitting the intent. Real fetch()
      // requires a registered contract, which the harness doesn't set
      // up yet. Once contracts are plumbed through, swap this for an
      // actual scaffold.fetch() against a feed contract.
      ctx.log('feed_view', {
        scroll,
        followed: currentFollowed,
      });
    }

    const sleepMs = Math.max(100, gaussian(ctx.random, interval.mean, interval.stddev));
    await ctx.sleep(sleepMs);
  }

  ctx.log('feed_session_end', {});
});

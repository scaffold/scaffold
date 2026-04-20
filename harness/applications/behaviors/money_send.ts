#!/usr/bin/env -S deno run --allow-all
/**
 * Money-send session: user with funds occasionally transfers a random
 * amount to another user.
 *
 * V1 emits `send_intent` events logging source/destination/amount; a
 * later iteration will wire this into scaffold.put() against the
 * Signature contract once auto-balancing in the harness is proven out.
 *
 * Params (in YAML application.params):
 *   sendIntervalMs -- { mean, stddev } between sends
 *   amount         -- { min, max } random amount per send
 *   sendCount      -- total number of sends before exit
 */

import { type AppContext, runApplication } from '../App.ts';
import { gaussian } from '../../rand.ts';

interface Params {
  sendIntervalMs?: { mean: number; stddev: number };
  amount?: { min: number; max: number };
  sendCount?: number;
}

runApplication(async (ctx: AppContext) => {
  const p = ctx.params as Params;
  const interval = p.sendIntervalMs ?? { mean: 5000, stddev: 1500 };
  const amount = p.amount ?? { min: 1, max: 100 };
  const sendCount = p.sendCount ?? 10;

  ctx.log('money_session_start', { sendCount, interval, amount });

  for (let i = 0; i < sendCount; i++) {
    if (ctx.shouldStop()) break;

    const peers = ctx.directory.snapshot().filter((pe) =>
      pe.pubkeyHex !== ctx.scaffold.publicKeyHex
    );
    if (peers.length === 0) {
      ctx.log('send_skipped', { reason: 'no_peers' });
    } else {
      const dest = peers[Math.floor(ctx.random() * peers.length)];
      const amt = Math.floor(
        amount.min + ctx.random() * (amount.max - amount.min),
      );
      ctx.log('send_intent', {
        destination: dest.pubkeyHex,
        amount: amt,
      });
    }

    const sleepMs = Math.max(200, gaussian(ctx.random, interval.mean, interval.stddev));
    await ctx.sleep(sleepMs);
  }

  ctx.log('money_session_end', {});
});

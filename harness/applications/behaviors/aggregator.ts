#!/usr/bin/env -S deno run --allow-all
/**
 * Aggregator session: long-lived participant that observes block
 * arrivals and reports fleet-wide aggregation rate.
 *
 * Aggregation block creation in Scaffold is driven by protocol state,
 * not by explicit behavior calls -- so this behavior mainly exists to
 * (a) keep a long-running node online and (b) emit periodic
 * observability summaries so the postgres observer can compute
 * aggregation incentive metrics.
 */

import { type AppContext, runApplication } from '../App.ts';

runApplication(async (ctx: AppContext) => {
  ctx.log('aggregator_session_start', {});

  let ticks = 0;
  while (!ctx.shouldStop()) {
    await ctx.sleep(3000);
    ticks += 1;
    ctx.log('aggregator_heartbeat', {
      tick: ticks,
      peers: ctx.directory.snapshot().length,
    });
  }

  ctx.log('aggregator_session_end', {});
});

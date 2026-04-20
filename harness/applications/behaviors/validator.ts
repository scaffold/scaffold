#!/usr/bin/env -S deno run --allow-all
/**
 * Validator session: a node that stays online, verifies incoming
 * blocks via Scaffold's default verification path, and emits periodic
 * state for the observer.
 *
 * V1 keeps this as a thin wrapper: Scaffold's enableVerification
 * flag is already controlled at construction time by App runtime.
 * Future iterations can push FOR collateral on verified blocks.
 */

import { type AppContext, runApplication } from '../App.ts';

runApplication(async (ctx: AppContext) => {
  ctx.log('validator_session_start', {});

  while (!ctx.shouldStop()) {
    await ctx.sleep(4000);
    ctx.log('validator_heartbeat', {
      peers: ctx.directory.snapshot().length,
    });
  }

  ctx.log('validator_session_end', {});
});

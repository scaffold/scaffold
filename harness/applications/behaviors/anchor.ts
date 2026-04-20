#!/usr/bin/env -S deno run --allow-all
/**
 * Anchor behavior: long-lived, participates in gossip without issuing
 * its own activity. New applications bootstrap to anchors first to
 * establish a warm backbone for gossip routing.
 */

import { runApplication } from '../App.ts';

runApplication(async (ctx) => {
  ctx.log('anchor_ready', {
    peersAtStart: ctx.directory.snapshot().length,
  });

  // Periodically report fleet status until asked to stop. Anchors don't
  // normally stop; this loop just keeps the process awake and emits
  // occasional state for the observer.
  while (!ctx.shouldStop()) {
    await ctx.sleep(5000);
    ctx.log('anchor_heartbeat', {
      peers: ctx.directory.snapshot().length,
    });
  }
});

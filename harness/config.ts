/**
 * YAML config schema for the harness coordinator. Validated with zod;
 * parse errors surface at coordinator startup with a useful message.
 */

import { parse as parseYaml } from '@std/yaml';
import { z } from 'zod';

const gaussianMs = z.object({
  mean: z.number().positive(),
  stddev: z.number().nonnegative(),
});

export const HarnessConfigSchema = z.object({
  run: z.object({
    id: z.string(),
    duration_s: z.number().positive(),
    force_close_rate: z.number().min(0).max(1),
    base_seed: z.number().int().default(1),
  }),
  users: z.object({
    count: z.number().int().positive(),
    seed_prefix: z.string().default('harness'),
    balance_distribution: z.object({
      zero_fraction: z.number().min(0).max(1),
      power_law: z.object({
        alpha: z.number().gt(1),
        min: z.number().positive(),
        max: z.number().positive(),
      }),
    }),
  }),
  geography: z.object({
    kind: z.literal('random_uniform'),
    latency: z.object({
      speed_factor: z.number().gt(0).max(1),
      jitter_min_ms: z.number().nonnegative(),
      jitter_max_ms: z.number().nonnegative(),
      min_ms: z.number().nonnegative(),
      fleet_fallback_ms: z.number().positive(),
    }),
  }),
  bootstrap: z.object({
    anchor_count: z.number().int().min(0),
    peers_per_new_app: z.number().int().min(1),
  }),
  applications: z.array(z.object({
    name: z.string(),
    entrypoint: z.string(),
    /** If true, treated as anchor (long-lived, never exits). */
    is_anchor: z.boolean().default(false),
    /** Ignored for anchors. */
    spawn_rate_per_s: z.number().nonnegative().default(0),
    /** Ignored for anchors. */
    session_duration_s: gaussianMs.optional(),
    params: z.record(z.unknown()).default({}),
  })),
  observer: z.object({
    postgres_url: z.string(),
    batch_size: z.number().int().positive().default(500),
    flush_interval_ms: z.number().int().positive().default(250),
    lag_threshold_bytes: z.number().int().positive().default(100_000_000),
  }),
  paths: z.object({
    runs_root: z.string().default('./runs'),
    socket_root: z.string().default('/tmp'),
  }).default({}),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;
export type ApplicationConfig = HarnessConfig['applications'][number];

export async function loadHarnessConfig(path: string): Promise<HarnessConfig> {
  const yaml = await Deno.readTextFile(path);
  const raw = parseYaml(yaml);
  const parsed = HarnessConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid harness config at ${path}:\n${parsed.error.toString()}`);
  }
  return parsed.data;
}

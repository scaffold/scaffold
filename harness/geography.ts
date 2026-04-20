/**
 * Geography: assigns coordinates to app sessions and computes expected
 * one-way latency between coordinate pairs.
 *
 * The interface is intentionally minimal so the v1 RandomUniformGeography
 * can be swapped for a population-weighted city sampler later without
 * touching the transport wiring.
 */

import type { Coord } from './types.ts';

export interface LatencyConfig {
  /**
   * Fraction of the speed of light in glass. Real fiber is ~0.6-0.7;
   * 0.5 is a comfortable default that produces recognizable trans-
   * continental RTTs (~140ms NY-SF).
   */
  speedFactor: number;
  jitterMinMs: number;
  jitterMaxMs: number;
  /** Floor applied after the haversine + jitter computation. */
  minMs: number;
}

export interface Geography {
  /** Sample a coordinate for a newly spawned session. */
  sampleCoord(rand: () => number): Coord;
  /** Expected one-way latency in ms between two coordinates, incl. jitter. */
  oneWayLatencyMs(a: Coord, b: Coord, rand: () => number): number;
}

export class RandomUniformGeography implements Geography {
  constructor(private readonly latency: LatencyConfig) {}

  sampleCoord(rand: () => number): Coord {
    const lon = rand() * 360 - 180;
    // Uniform area-weighted sampling: invert CDF of sin(lat) so the
    // distribution doesn't clump at the poles.
    const u = rand() * 2 - 1;
    const lat = (Math.asin(u) * 180) / Math.PI;
    return { lat, lon };
  }

  oneWayLatencyMs(a: Coord, b: Coord, rand: () => number): number {
    const meters = haversineMeters(a, b);
    const c = this.latency.speedFactor * 299_792_458;
    const propagationMs = (meters / c) * 1000;
    const jitter = this.latency.jitterMinMs +
      rand() * (this.latency.jitterMaxMs - this.latency.jitterMinMs);
    return Math.max(this.latency.minMs, propagationMs + jitter);
  }
}

const EARTH_RADIUS_M = 6_371_000;

export function haversineMeters(a: Coord, b: Coord): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

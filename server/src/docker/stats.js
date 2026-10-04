// =============================================================================
// Turning Docker's raw stats into numbers a human (or an alert rule) can use.
//
// Docker does NOT give you "CPU: 43%". It gives you counters — the total
// nanoseconds of CPU the container has ever consumed — and leaves the maths
// to you. Get the maths wrong and every downstream decision is wrong too.
//
// THE TWO TRAPS (both from plan §5)
// ---------------------------------------------------------------------------
// 1. CPU needs two samples. The first reading has no previous reading to
//    compare against, and Docker fills precpu_stats with zeros. Dividing by
//    zero-ish values produces garbage like 4000%. We return 0 for that sample.
//
// 2. Memory must subtract file cache. `memory_stats.usage` includes page cache
//    that Linux will hand back instantly if asked. Count it and every
//    container sits at 90%+ forever and memory alerts never stop firing.
//    On cgroup v2 (which WSL2 uses) the cache figure is `inactive_file`.
// =============================================================================

import { docker, withTimeout } from './client.js';

/**
 * CPU percentage across all cores, normalised so 100% = one full core.
 * Returns 0 when there is no previous sample to compare against.
 */
export function calculateCpuPercent(stats) {
  const cpu    = stats.cpu_stats;
  const precpu = stats.precpu_stats;

  // First sample after a container starts: nothing to diff against.
  if (!precpu || !precpu.system_cpu_usage || !precpu.cpu_usage?.total_usage) return 0;

  const cpuDelta    = cpu.cpu_usage.total_usage - precpu.cpu_usage.total_usage;
  const systemDelta = cpu.system_cpu_usage      - precpu.system_cpu_usage;

  if (systemDelta <= 0 || cpuDelta < 0) return 0;

  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  const pct = (cpuDelta / systemDelta) * cores * 100;

  // Clamp: a 6-core box can legitimately show 600%, but anything beyond that
  // is a measurement glitch, not a real reading.
  return Math.min(Math.round(pct * 10) / 10, cores * 100);
}

/**
 * Real memory in use, excluding reclaimable cache, plus the limit and a %.
 */
export function calculateMemory(stats) {
  const m = stats.memory_stats ?? {};
  const usage = m.usage ?? 0;
  const limit = m.limit ?? 0;

  // cgroup v2 (WSL2, modern Linux) → inactive_file
  // cgroup v1 (older Docker)       → cache
  const cache = m.stats?.inactive_file ?? m.stats?.cache ?? 0;
  const used  = Math.max(usage - cache, 0);

  const pct = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
  return { used, limit, pct };
}

/**
 * One-shot stats for a container. `stream: false` asks Docker for a single
 * snapshot rather than a live feed. Docker still populates precpu_stats in
 * that snapshot (it keeps the previous reading server-side), so the CPU
 * calculation works on the second and later polls.
 */
export async function getStats(name) {
  const raw = await withTimeout(
    docker.getContainer(name).stats({ stream: false }),
    5000,
    `stats ${name}`
  );
  return {
    cpu_pct: calculateCpuPercent(raw),
    ...calculateMemory(raw),
  };
}

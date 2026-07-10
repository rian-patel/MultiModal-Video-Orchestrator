import type { Asset, Engine, EngineContext, Shot, VisionResult } from '@rev/core';
import { ROOM_PRIORITY } from './roomPriority';

export * from './roomPriority';

export interface StoryboardInput {
  assets: Asset[];
  vision: VisionResult[];
  targetDurationSec: number;
}

/**
 * Per-clip durations for n clips covering targetDurationSec with crossfade
 * overlaps. Exact fit (cumulative rounding, sums to the target) when n is the
 * ideal clip count for the target; otherwise every clip runs full length and
 * the video comes out shorter. Also used by the server to re-pace the tour
 * after review-screen edits.
 */
export function paceDurations(
  n: number,
  targetDurationSec: number,
  clipMaxSec: number,
  xfadeSec: number,
): number[] {
  const denom = Math.max(0.1, clipMaxSec - xfadeSec);
  const nIdeal = Math.max(1, Math.ceil((targetDurationSec - xfadeSec) / denom));
  const durations = new Array<number>(n);
  if (n === nIdeal) {
    const d = (targetDurationSec + (nIdeal - 1) * xfadeSec) / nIdeal; // <= clipMax by construction
    // Cumulative rounding: each clip is round(d) +/- 0.01 and the series
    // sums to n*d exactly, so no clip ever exceeds clipMax.
    let prevCum = 0;
    for (let i = 0; i < n; i++) {
      const cum = Math.round(d * (i + 1) * 100) / 100;
      durations[i] = Math.round((cum - prevCum) * 100) / 100;
      prevCum = cum;
    }
  } else {
    durations.fill(clipMaxSec);
  }
  return durations;
}

interface Candidate {
  asset: Asset;
  vision: VisionResult;
  /** Stable tie-breaker so selection is deterministic. */
  idx: number;
}

/**
 * Rule-based tour builder. Three jobs, all local logic:
 *   1. FILTER — drop photos below the quality floor (a shorter, better video
 *      beats a padded one; garbage images from Vision score ~0.05).
 *   2. SELECT — coverage first (best photo of each room), then fill by quality
 *      with a soft per-room cap so one room can't dominate the tour.
 *   3. PACE — pick the smallest clip count that can cover the target length,
 *      then trim each clip evenly so the final cut lands on the target
 *      exactly (clips can be trimmed in render, never extended).
 */
export class RuleBasedStoryboardEngine implements Engine<StoryboardInput, Shot[]> {
  readonly name = 'storyboard:rule-based';

  async process(input: StoryboardInput, ctx: EngineContext): Promise<Shot[]> {
    const { assets, vision, targetDurationSec } = input;
    const { clipDurationSec: clipMax, crossfadeSec: xfade } = ctx.config;
    const { minQualityScore, maxShotsPerRoom } = ctx.config.storyboard;

    const byId = new Map(vision.map((v) => [v.assetId, v]));
    const all: Candidate[] = assets
      .map((asset, idx) => ({ asset, vision: byId.get(asset.id), idx }))
      .filter((c): c is Candidate => Boolean(c.vision));

    // 1. Quality floor
    const eligible = all.filter((c) => c.vision.qualityScore >= minQualityScore);
    const dropped = all.length - eligible.length;
    if (eligible.length === 0) {
      const best = all.length ? Math.max(...all.map((c) => c.vision.qualityScore)) : 0;
      throw new Error(
        `No photos passed the quality floor (${minQualityScore}). Best score was ${best.toFixed(2)} — ` +
          `these images may not be usable property photos.`,
      );
    }

    // Smallest n whose clips (each <= clipMax) can cover the target exactly:
    // n*d - (n-1)*xfade = target with d <= clipMax  =>  n >= (target-xfade)/(clipMax-xfade)
    const denom = Math.max(0.1, clipMax - xfade);
    const nIdeal = Math.max(1, Math.ceil((targetDurationSec - xfade) / denom));
    const n = Math.min(nIdeal, eligible.length);

    // 2. Selection
    const byTour = (a: Candidate, b: Candidate) =>
      ROOM_PRIORITY[a.vision.roomType] - ROOM_PRIORITY[b.vision.roomType] ||
      b.vision.qualityScore - a.vision.qualityScore ||
      a.idx - b.idx;
    const byQuality = (a: Candidate, b: Candidate) =>
      b.vision.qualityScore - a.vision.qualityScore || a.idx - b.idx;

    const sorted = [...eligible].sort(byTour);
    const chosen: Candidate[] = [];
    const perRoom = new Map<string, number>();
    const take = (c: Candidate) => {
      chosen.push(c);
      perRoom.set(c.vision.roomType, (perRoom.get(c.vision.roomType) ?? 0) + 1);
    };

    // Pass 1 — coverage: the best photo of each distinct room, in tour order.
    for (const c of sorted) {
      if (chosen.length >= n) break;
      if (!perRoom.has(c.vision.roomType)) take(c);
    }
    // Pass 2 — fill by quality, capped per room so variety wins over one
    // photogenic room.
    const rest = () => sorted.filter((c) => !chosen.includes(c)).sort(byQuality);
    for (const c of rest()) {
      if (chosen.length >= n) break;
      if ((perRoom.get(c.vision.roomType) ?? 0) < maxShotsPerRoom) take(c);
    }
    // Pass 3 — overflow: if slots remain (everything left is over the cap),
    // fill by quality anyway rather than shorten the video.
    for (const c of rest()) {
      if (chosen.length >= n) break;
      take(c);
    }

    chosen.sort(byTour);

    // 3. Pacing — exact fit when we have enough clips; otherwise every clip
    // runs full length and the video is shorter than requested.
    const durations = paceDurations(chosen.length, targetDurationSec, clipMax, xfade);

    const shots: Shot[] = chosen.map((c, i) => ({
      order: i,
      assetId: c.asset.id,
      roomType: c.vision.roomType,
      durationSec: durations[i],
      status: 'pending',
    }));

    const total =
      Math.round((durations.reduce((a, b) => a + b, 0) - (shots.length - 1) * xfade) * 100) / 100;

    let msg = `Selected ${shots.length}/${all.length} photos -> ~${total}s tour`;
    if (dropped > 0) msg += ` (${dropped} dropped below quality floor ${minQualityScore})`;
    if (total < targetDurationSec - 2) {
      msg += ` — shorter than the requested ${targetDurationSec}s: only ${eligible.length} usable photos`;
      ctx.logger.warn(msg);
    }
    ctx.progress(100, msg);
    ctx.logger.info(`Tour: ${shots.map((s) => s.roomType).join(' -> ')}`);
    return shots;
  }
}

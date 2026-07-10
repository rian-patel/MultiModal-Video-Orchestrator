import { useState } from 'react';
import type { ReviewEventData, ReviewShot } from '@rev/core';

interface Props {
  review: ReviewEventData;
  /** Called with the final tour (asset ids, in order) when the user approves. */
  onAnimate: (assetIds: string[]) => void;
  onDiscard: () => void;
}

/** Room accents for shots without a thumbnail (demo/mock assets). */
const ROOM_COLOR: Record<string, string> = {
  exterior_front: '#7A8CA8',
  foyer: '#C9B28A',
  living_room: '#B58E6A',
  kitchen: '#D8D8CF',
  dining: '#A3765A',
  primary_bedroom: '#9AA0B5',
  bedroom: '#8EA2B8',
  bathroom: '#DFE6EA',
  office: '#7F8B73',
  outdoor: '#6AA877',
  aerial: '#6B93C4',
};

const roomLabel = (r: string) => r.replace(/_/g, ' ');

/**
 * Estimated cut length for n clips. Mirrors the server's paceDurations
 * outcome (keep in sync with packages/engine-storyboard paceDurations):
 * exact target when n is the ideal clip count, otherwise full-length clips.
 */
function estimateTotalSec(n: number, target: number, clip: number, xfade: number): number {
  if (n === 0) return 0;
  const nIdeal = Math.max(1, Math.ceil((target - xfade) / Math.max(0.1, clip - xfade)));
  if (n === nIdeal) return target;
  return Math.round((n * clip - (n - 1) * xfade) * 100) / 100;
}

function Thumb({ shot, dimmed = false }: { shot: ReviewShot; dimmed?: boolean }) {
  const cls = `h-14 w-20 shrink-0 rounded-md border border-slate-700 object-cover ${dimmed ? 'opacity-50' : ''}`;
  if (shot.thumbUrl) return <img src={shot.thumbUrl} alt={roomLabel(shot.roomType)} className={cls} />;
  return (
    <div
      className={cls}
      style={{ backgroundColor: ROOM_COLOR[shot.roomType] ?? '#888888' }}
      aria-label={roomLabel(shot.roomType)}
    />
  );
}

/**
 * The storyboard review checkpoint: the tour is planned and prompted but no
 * clips have been generated (nothing spent yet). Reorder or drop shots, then
 * Animate to continue the pipeline.
 */
export function ReviewScreen({ review, onAnimate, onDiscard }: Props) {
  const [shots, setShots] = useState<ReviewShot[]>(review.shots);
  const [removed, setRemoved] = useState<ReviewShot[]>([]);

  const move = (i: number, delta: -1 | 1) => {
    const j = i + delta;
    if (j < 0 || j >= shots.length) return;
    const next = [...shots];
    [next[i], next[j]] = [next[j], next[i]];
    setShots(next);
  };
  const remove = (i: number) => {
    if (shots.length <= 1) return;
    setShots(shots.filter((_, k) => k !== i));
    setRemoved([...removed, shots[i]]);
  };
  const restore = (i: number) => {
    setShots([...shots, removed[i]]);
    setRemoved(removed.filter((_, k) => k !== i));
  };

  const total = estimateTotalSec(
    shots.length,
    review.targetDurationSec,
    review.clipDurationSec,
    review.crossfadeSec,
  );

  return (
    <div className="rounded-xl border border-sky-500/30 bg-sky-500/5 p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-semibold text-sky-400">Review your tour</p>
        <p className="text-sm text-slate-300">
          {shots.length} shots · ~{total}s
        </p>
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Nothing has been animated yet. Reorder or remove shots, then hit Animate.
      </p>

      <ul className="mt-3 space-y-2">
        {shots.map((s, i) => (
          <li
            key={s.assetId}
            className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/60 p-2"
          >
            <span className="w-5 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
            <Thumb shot={s} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium capitalize text-slate-200">
                {roomLabel(s.roomType)}
                {s.motionPreset && (
                  <span className="ml-2 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-normal normal-case text-slate-400">
                    {s.motionPreset}
                  </span>
                )}
              </p>
              <p className="truncate text-xs text-slate-500">{s.description ?? s.prompt ?? ''}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={`Move shot ${i + 1} up`}
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === shots.length - 1}
                aria-label={`Move shot ${i + 1} down`}
                className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                disabled={shots.length <= 1}
                aria-label={`Remove shot ${i + 1}`}
                className="rounded border border-rose-500/40 px-2 py-1 text-xs text-rose-400 hover:bg-rose-500/10 disabled:opacity-30"
              >
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>

      {removed.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium text-slate-400">Removed</p>
          <ul className="mt-1 space-y-1">
            {removed.map((s, i) => (
              <li
                key={s.assetId}
                className="flex items-center gap-3 rounded-lg border border-slate-800/60 p-2 opacity-70"
              >
                <Thumb shot={s} dimmed />
                <span className="flex-1 text-xs capitalize text-slate-400">{roomLabel(s.roomType)}</span>
                <button
                  type="button"
                  onClick={() => restore(i)}
                  className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {review.bench.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          Not selected ({review.bench.length}):{' '}
          <span className="capitalize">
            {review.bench.map((b) => roomLabel(b.roomType)).join(', ')}
          </span>
        </p>
      )}

      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={() => onAnimate(shots.map((s) => s.assetId))}
          className="flex-1 rounded-lg bg-sky-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-400"
        >
          Animate {shots.length} shots (~{total}s)
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-lg border border-slate-700 px-4 py-2.5 text-sm text-slate-400 transition-colors hover:bg-slate-800"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

import type { CompleteEventData } from '@rev/core';

interface Props {
  result: CompleteEventData;
}

/** The finished tour: in-app playback plus a download link. */
export function ResultCard({ result }: Props) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-baseline justify-between">
        <p className="font-semibold text-emerald-400">Tour complete</p>
        <p className="text-sm text-slate-300">
          {result.shotCount} shots · ~{result.totalDurationSec}s
        </p>
      </div>

      <video
        key={result.projectId}
        src={result.videoUrl}
        controls
        playsInline
        preload="metadata"
        className="mt-3 aspect-video w-full rounded-lg border border-slate-800 bg-black"
      />

      <p className="mt-2 text-xs capitalize text-slate-400">
        {result.rooms.map((r) => r.replace(/_/g, ' ')).join(' → ')}
      </p>

      <a
        href={`${result.videoUrl}?download`}
        download
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-400"
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="size-4" aria-hidden>
          <path d="M8 1a.75.75 0 0 1 .75.75v6.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V1.75A.75.75 0 0 1 8 1Z" />
          <path d="M2 11.75a.75.75 0 0 1 1.5 0v1.5c0 .14.11.25.25.25h8.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 12.25 15h-8.5A1.75 1.75 0 0 1 2 13.25v-1.5Z" />
        </svg>
        Download MP4
      </a>
    </div>
  );
}

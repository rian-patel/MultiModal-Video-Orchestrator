import type { ProgressEventData } from '@rev/core';

interface Props {
  progress: ProgressEventData | null;
}

export function ProgressBar({ progress }: Props) {
  const pct = progress?.pct ?? 0;
  return (
    <div aria-live="polite">
      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="font-medium capitalize text-slate-200">
          {progress?.stage ?? 'Starting…'}
        </span>
        <span className="tabular-nums text-slate-400">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-700">
        <div
          className="h-full rounded-full bg-sky-400 transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 min-h-5 truncate text-xs text-slate-400">{progress?.msg ?? ''}</p>
    </div>
  );
}

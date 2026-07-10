import { useEffect, useState } from 'react';
import type { CompleteEventData, HealthData, ProgressEventData } from '@rev/core';
import { checkHealth, resumeRun, startRun, watchRun } from './api';
import { Dropzone } from './components/Dropzone';
import { LengthSelector, type TourLength } from './components/LengthSelector';
import { ProgressBar } from './components/ProgressBar';
import { ResultCard } from './components/ResultCard';

type Phase = 'idle' | 'running' | 'complete' | 'error';

export default function App() {
  const [health, setHealth] = useState<HealthData | null | undefined>(undefined);
  const [files, setFiles] = useState<File[]>([]);
  const [length, setLength] = useState<TourLength>(45);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [result, setResult] = useState<CompleteEventData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    void checkHealth().then(setHealth);
  }, []);

  const usingDemo = files.length === 0;
  const countValid = usingDemo || (files.length >= 10 && files.length <= 40);
  const busy = phase === 'running';

  function follow(runId: string) {
    watchRun(runId, {
      onProgress: setProgress,
      onComplete: (d) => {
        setResult(d);
        setProjectId(d.projectId);
        setPhase('complete');
      },
      onError: (d) => {
        setError(d.message);
        if (d.projectId) setProjectId(d.projectId);
        setPhase('error');
      },
    });
  }

  async function handleGenerate() {
    setPhase('running');
    setProgress(null);
    setResult(null);
    setError(null);
    setProjectId(null);
    try {
      follow(await startRun(length, usingDemo ? undefined : files));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  // Picks up a failed run at its last checkpoint: finished stages are
  // skipped and already-generated clips are never re-paid for.
  async function handleResume() {
    if (!projectId) return;
    setPhase('running');
    setProgress(null);
    setError(null);
    try {
      follow(await resumeRun(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  const engineLine = health
    ? `analysis: ${health.engines.vision === 'claude' ? 'Claude' : 'mock'} · clips: ${
        health.engines.videogen === 'higgsfield' ? 'Higgsfield' : 'mock'
      }`
    : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <div className="mx-auto max-w-2xl px-6 py-12">
        <header className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Real Estate Video Generator</h1>
            <p className="mt-1 text-sm text-slate-400">
              Photos in, cinematic tour out.
              {engineLine && <span className="text-slate-500"> ({engineLine})</span>}
            </p>
          </div>
          <span
            className={[
              'mt-1 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
              health === undefined
                ? 'border-slate-600 text-slate-400'
                : health
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : 'border-rose-500/40 bg-rose-500/10 text-rose-400',
            ].join(' ')}
          >
            <span className="size-1.5 rounded-full bg-current" />
            {health === undefined ? 'checking…' : health ? 'API connected' : 'API offline'}
          </span>
        </header>

        <main className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <Dropzone files={files} onChange={setFiles} disabled={busy} />
          <LengthSelector value={length} onChange={setLength} disabled={busy} />

          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy || !countValid || health === null}
            className="w-full rounded-lg bg-sky-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {busy ? 'Generating…' : `Generate ${length}s tour`}
          </button>

          {phase === 'running' && <ProgressBar progress={progress} />}

          {phase === 'complete' && result && <ResultCard result={result} />}

          {phase === 'error' && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
              <p className="font-semibold text-rose-400">Generation failed</p>
              <p className="mt-1 text-sm text-slate-300">{error}</p>
              {projectId && (
                <button
                  type="button"
                  onClick={handleResume}
                  className="mt-3 w-full rounded-lg border border-rose-500/40 bg-rose-500/10 py-2.5 text-sm font-semibold text-rose-300 transition-colors hover:bg-rose-500/20"
                >
                  Resume from last checkpoint
                </button>
              )}
            </div>
          )}
        </main>

        <footer className="mt-6 text-center text-xs text-slate-600">
          Upload → Vision → Storyboard → Prompt → VideoGen → Render
        </footer>
      </div>
    </div>
  );
}

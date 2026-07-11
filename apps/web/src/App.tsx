import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type {
  CompleteEventData,
  HealthData,
  ProgressEventData,
  ReviewEventData,
} from '@rev/core';
import * as localApi from './api';
import type { BrandingInput } from './api';
import * as hostedApi from './hosted/api';
import { hostedMode, supabase } from './hosted/client';
import { BrandingSection } from './components/BrandingSection';
import { Dropzone } from './components/Dropzone';
import { LengthSelector, type TourLength } from './components/LengthSelector';
import { ProgressBar } from './components/ProgressBar';
import { ResultCard } from './components/ResultCard';
import { ReviewScreen } from './components/ReviewScreen';
import { SignIn } from './components/SignIn';

type Phase = 'idle' | 'running' | 'review' | 'complete' | 'error';

// Same surface, two transports: Fastify/SSE locally, Supabase/Realtime hosted.
const { checkHealth, patchStoryboard, resumeRun, startRun, watchRun } = hostedMode
  ? hostedApi
  : localApi;

export default function App() {
  const [health, setHealth] = useState<HealthData | null | undefined>(undefined);
  const [session, setSession] = useState<Session | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [length, setLength] = useState<TourLength>(45);
  const [branding, setBranding] = useState<BrandingInput>({});
  // Hosted runs don't support the review checkpoint yet.
  const [reviewFirst, setReviewFirst] = useState(!hostedMode);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<ProgressEventData | null>(null);
  const [review, setReview] = useState<ReviewEventData | null>(null);
  const [result, setResult] = useState<CompleteEventData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!hostedMode) {
      void checkHealth().then(setHealth);
      return;
    }
    const sb = supabase();
    void sb.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = sb.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (hostedMode && session) void checkHealth().then(setHealth);
  }, [session]);

  // Hosted mode has no demo path: real photos are required.
  const usingDemo = !hostedMode && files.length === 0;
  const countValid = usingDemo || (files.length >= 10 && files.length <= 40);
  const busy = phase === 'running';

  function follow(runId: string) {
    watchRun(runId, {
      onProgress: setProgress,
      onReview: (d) => {
        setReview(d);
        setProjectId(d.projectId);
        setPhase('review');
      },
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
    setReview(null);
    setResult(null);
    setError(null);
    setProjectId(null);
    try {
      follow(await startRun(length, usingDemo ? undefined : files, reviewFirst, branding));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  }

  // Approve the (possibly edited) storyboard: persist the edits, then
  // continue the pipeline from the 'prompted' checkpoint via resume.
  async function handleAnimate(assetIds: string[]) {
    if (!projectId) return;
    setPhase('running');
    setProgress(null);
    try {
      await patchStoryboard(projectId, assetIds);
      follow(await resumeRun(projectId));
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
      } · fidelity: ${health.engines.fidelity === 'claude' ? 'Claude' : 'off'}`
    : null;

  // Hosted mode gates everything behind sign-in (invite-only alpha).
  if (hostedMode && !session) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <div className="mx-auto max-w-2xl px-6 py-12">
          <header className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">Real Estate Video Generator</h1>
            <p className="mt-1 text-sm text-slate-400">Photos in, cinematic tour out.</p>
          </header>
          <SignIn />
        </div>
      </div>
    );
  }

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
          <div className="flex flex-col items-end gap-2">
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
              {health === undefined ? 'checking…' : health ? (hostedMode ? 'Cloud' : 'API connected') : 'API offline'}
            </span>
            {hostedMode && session && (
              <button
                type="button"
                onClick={() => void supabase().auth.signOut()}
                className="text-xs text-slate-500 underline hover:text-slate-300"
              >
                {session.user.email} · sign out
              </button>
            )}
          </div>
        </header>

        <main className="space-y-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <Dropzone files={files} onChange={setFiles} disabled={busy} />
          <LengthSelector value={length} onChange={setLength} disabled={busy} />
          <BrandingSection value={branding} onChange={setBranding} disabled={busy} />

          {!hostedMode && (
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={reviewFirst}
                onChange={(e) => setReviewFirst(e.target.checked)}
                disabled={busy}
                className="size-4 accent-sky-500"
              />
              Review the storyboard before animating
              <span className="text-xs text-slate-500">(no clips are paid for until you approve)</span>
            </label>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={busy || !countValid || health === null}
            className="w-full rounded-lg bg-sky-500 py-3 text-sm font-semibold text-white transition-colors hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {busy ? 'Generating…' : `Generate ${length}s tour`}
          </button>

          {phase === 'running' && <ProgressBar progress={progress} />}

          {phase === 'review' && review && (
            <ReviewScreen
              key={review.projectId}
              review={review}
              onAnimate={handleAnimate}
              onDiscard={() => setPhase('idle')}
            />
          )}

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

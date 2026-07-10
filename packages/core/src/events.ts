// Wire-format types shared by the server (SSE producer) and the web UI
// (SSE consumer). Keeping them in @rev/core means front and back can never
// drift apart silently.

export type RunStatus = 'running' | 'review' | 'complete' | 'error';

/** SSE `progress` event payload. */
export interface ProgressEventData {
  /** Global 0..100 across all pipeline stages. */
  pct: number;
  /** Engine/stage name, e.g. "vision". */
  stage: string;
  msg: string;
}

/** SSE `complete` event payload. */
export interface CompleteEventData {
  projectId: string;
  /** Server URL that streams the finished MP4 (append `?download` for an attachment). */
  videoUrl: string;
  outputPath: string;
  totalDurationSec: number;
  shotCount: number;
  /** Room sequence of the final tour (successful shots only), in order. */
  rooms: string[];
}

/** SSE `run-error` event payload. */
export interface ErrorEventData {
  message: string;
  /** Set once the project exists on disk — enables "Resume" in the UI. */
  projectId?: string;
}

/** One shot (or benched photo) as shown on the storyboard review screen. */
export interface ReviewShot {
  assetId: string;
  order: number;
  roomType: string;
  durationSec: number;
  prompt?: string;
  motionPreset?: string;
  /** Vision's one-line scene description. */
  description?: string;
  qualityScore?: number;
  /** Server URL for the photo thumbnail (absent for mock/demo assets). */
  thumbUrl?: string;
}

/**
 * SSE `review` event payload (runs started with `review: true` stop after
 * the Prompt stage — before any paid clip generation — and emit this).
 * Also the response shape of GET/PATCH /api/projects/:id/storyboard.
 */
export interface ReviewEventData {
  projectId: string;
  stage: string;
  targetDurationSec: number;
  /** Planned length of the current cut. */
  totalDurationSec: number;
  /** Config the client needs to estimate durations while editing. */
  clipDurationSec: number;
  crossfadeSec: number;
  shots: ReviewShot[];
  /** Analyzed photos that didn't make the cut (quality-ranked). */
  bench: ReviewShot[];
}

/** `GET /api/health` response. */
export interface HealthData {
  ok: boolean;
  service: string;
  /** Which implementation each key-gated engine will use for the next run. */
  engines: {
    vision: 'claude' | 'mock';
    videogen: 'higgsfield' | 'mock';
  };
}

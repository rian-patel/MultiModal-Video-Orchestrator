import { task } from '@trigger.dev/sdk';
import { hostedRun, type GenerateTourPayload } from '../hostedRun';

/**
 * The hosted pipeline as one Trigger.dev task. Retries are disabled at the
 * task level (see trigger.config.ts): a whole-task retry would start a fresh
 * pipeline and re-bill every Higgsfield clip. Failure recovery is the resume
 * flow, which keeps finished clips.
 */
export const generateTour = task({
  id: 'generate-tour',
  retry: { maxAttempts: 1 },
  // Global serialization: one run at a time across all users. One run uses up
  // to 2 concurrent Higgsfield clips, which is exactly the account's 2-job
  // plan ceiling, so this also removes the duplicate-resume double-bill race
  // (two triggers for the same project can never execute at once). Raising
  // this requires a higher Higgsfield concurrency plan first.
  queue: { concurrencyLimit: 1 },
  // ffmpeg encodes many 1080p streams; give it headroom over the default.
  machine: 'small-2x',
  run: async (payload: GenerateTourPayload) => {
    await hostedRun(payload);
  },
});

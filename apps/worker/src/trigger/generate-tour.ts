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
  run: async (payload: GenerateTourPayload) => {
    await hostedRun(payload);
  },
});

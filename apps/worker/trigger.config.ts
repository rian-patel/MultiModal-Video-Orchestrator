import { defineConfig } from '@trigger.dev/sdk';
import { ffmpeg } from '@trigger.dev/build/extensions/core';

export default defineConfig({
  // From the Trigger.dev dashboard (Project settings -> Project ref).
  project: process.env.TRIGGER_PROJECT_REF ?? 'proj_SET_TRIGGER_PROJECT_REF',
  dirs: ['./src/trigger'],
  // A full tour is 7-14 clips at up to ~16 min each (2 concurrent), so the
  // worst honest case is around 2 hours. Most runs finish in 15-30 min.
  maxDuration: 7200,
  // NEVER retry the whole task: a retry would start a fresh pipeline and
  // re-bill every clip. Recovery is the resume flow, which skips paid work.
  retries: { enabledInDev: false, default: { maxAttempts: 1 } },
  build: {
    // ffmpeg(): installs a system ffmpeg in the worker image and sets
    // FFMPEG_PATH, which the render/fidelity/mock engines prefer over
    // ffmpeg-static. sharp ships native binaries: keep both un-bundled.
    extensions: [ffmpeg()],
    external: ['sharp', 'ffmpeg-static'],
  },
});

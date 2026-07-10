export interface PipelineConfig {
  /** Length of each generated clip, in seconds (Higgsfield-dependent). */
  clipDurationSec: number;
  /** Crossfade overlap between adjacent clips, in seconds. */
  crossfadeSec: number;
  resolution: { width: number; height: number };
  higgsfield: {
    defaultMotion: string;
    maxConcurrency: number;
  };
  storyboard: {
    /** Photos scoring below this quality are excluded from the tour. */
    minQualityScore: number;
    /** Soft cap on shots per room type during quality fill (coverage first). */
    maxShotsPerRoom: number;
  };
  /** Root dir for per-project working directories. */
  projectsDir: string;
}

export const defaultConfig: PipelineConfig = {
  clipDurationSec: 5,
  crossfadeSec: 0.75,
  resolution: { width: 1920, height: 1080 },
  higgsfield: { defaultMotion: 'dolly_in', maxConcurrency: 3 },
  storyboard: { minQualityScore: 0.3, maxShotsPerRoom: 2 },
  projectsDir: 'projects',
};

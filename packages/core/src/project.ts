// The shared "spine" that flows through every engine. Each engine reads the
// slice it needs and returns an enriched slice; the orchestrator writes it back.

export type RoomType =
  | 'exterior_front'
  | 'foyer'
  | 'living_room'
  | 'kitchen'
  | 'dining'
  | 'bedroom'
  | 'primary_bedroom'
  | 'bathroom'
  | 'office'
  | 'outdoor'
  | 'aerial'
  | 'detail'
  | 'other';

export type Lighting = 'bright' | 'warm' | 'dim' | 'mixed';

// `stage` is a checkpoint: it only advances when the work it names is safely
// on disk ('generating'/'rendering' are set just before their stage starts).
// A failed run keeps its stage — that is exactly where resume picks up; the
// failure itself is recorded in `lastError`.
export type ProjectStage =
  | 'created'
  | 'uploaded'
  | 'analyzed'
  | 'storyboarded'
  | 'prompted'
  | 'generating'
  | 'rendering'
  | 'complete';

export type ShotStatus = 'pending' | 'generating' | 'done' | 'failed';

/** Produced by the Upload Engine. */
export interface Asset {
  id: string;
  sourcePath: string;
  /** Small preview image (real Upload Engine only). */
  thumbPath?: string;
  originalName: string;
  width: number;
  height: number;
}

/** Produced by the Vision Engine, keyed to Asset.id. */
export interface VisionResult {
  assetId: string;
  roomType: RoomType;
  description: string;
  features: string[];
  lighting: Lighting;
  suggestedMove: string;
  /** 0..1 — drives selection in the Storyboard Engine. */
  qualityScore: number;
}

/** Produced by Storyboard, enriched by Prompt and VideoGen. */
export interface Shot {
  order: number;
  assetId: string;
  roomType: RoomType;
  durationSec: number;
  prompt?: string;
  motionPreset?: string;
  higgsfieldJobId?: string;
  clipPath?: string;
  status: ShotStatus;
}

export interface Project {
  id: string;
  createdAt: string;
  targetDurationSec: 30 | 45 | 60;
  stage: ProjectStage;
  assets: Asset[];
  vision: VisionResult[];
  shots: Shot[];
  outputPath?: string;
  /** Why the last run stopped; cleared when a resume starts. */
  lastError?: string;
}

import type { Branding, Shot } from '@rev/core';

export interface RenderInput {
  shots: Shot[];
  outputPath: string;
  /** Optional agent/property branding: title/end cards + logo watermark. */
  branding?: Branding;
}

export interface RenderResult {
  outputPath: string;
  planPath: string;
  totalDurationSec: number;
  /** 9:16 blur-pad social cut derived from the master (real engine only). */
  verticalPath?: string;
}

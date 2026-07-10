import type { Shot } from '@rev/core';

export interface RenderInput {
  shots: Shot[];
  outputPath: string;
}

export interface RenderResult {
  outputPath: string;
  planPath: string;
  totalDurationSec: number;
}

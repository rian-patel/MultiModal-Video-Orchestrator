import type { PipelineConfig } from './config';
import type { Logger } from './logger';

export type ProgressFn = (pct: number, msg: string) => void;

/** Everything an engine needs from the outside world. */
export interface EngineContext {
  /** Per-project working dir, e.g. projects/<id>. */
  workDir: string;
  config: PipelineConfig;
  logger: Logger;
  /** Report progress 0..100 within this engine's own stage. */
  progress: ProgressFn;
}

/**
 * The one contract every engine implements. Narrow, testable I/O keeps engines
 * independent and swappable — the orchestrator does all the wiring.
 */
export interface Engine<TIn, TOut> {
  readonly name: string;
  process(input: TIn, ctx: EngineContext): Promise<TOut>;
}

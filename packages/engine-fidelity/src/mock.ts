import type { Engine, EngineContext, Shot } from '@rev/core';
import type { FidelityInput } from './types';

/**
 * Pass-through fidelity engine for keyless/demo runs: every clip is accepted
 * unaudited (mock clips are solid colors — there is nothing to audit).
 */
export class MockFidelityEngine implements Engine<FidelityInput, Shot[]> {
  readonly name = 'fidelity:mock';

  async process(input: FidelityInput, ctx: EngineContext): Promise<Shot[]> {
    ctx.progress(100, 'Fidelity audit skipped (mock)');
    return input.shots;
  }
}

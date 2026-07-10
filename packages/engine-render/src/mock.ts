import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Engine, EngineContext } from '@rev/core';
import type { RenderInput, RenderResult } from './types';

/** Writes a render plan + placeholder file instead of running FFmpeg. */
export class MockRenderEngine implements Engine<RenderInput, RenderResult> {
  readonly name = 'render:mock';

  async process(input: RenderInput, ctx: EngineContext): Promise<RenderResult> {
    const usable = input.shots.filter((s) => s.status === 'done' && s.clipPath);
    const { crossfadeSec } = ctx.config;

    const rawTotal = usable.reduce((sum, s) => sum + s.durationSec, 0);
    const totalDurationSec = Number(
      (rawTotal - Math.max(0, usable.length - 1) * crossfadeSec).toFixed(2),
    );

    const plan = {
      engine: this.name,
      resolution: ctx.config.resolution,
      crossfadeSec,
      clips: usable.map((s) => ({
        order: s.order,
        room: s.roomType,
        clip: s.clipPath,
        durationSec: s.durationSec,
        motion: s.motionPreset,
      })),
      totalDurationSec,
    };

    await mkdir(dirname(input.outputPath), { recursive: true });
    const planPath = `${dirname(input.outputPath)}/render-plan.json`;
    await writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
    await writeFile(
      input.outputPath,
      `MOCK MP4 — ${usable.length} clips, ~${totalDurationSec}s. See render-plan.json for the concat recipe.\n`,
      'utf8',
    );

    ctx.progress(100, `Rendered ${usable.length} clips -> ${totalDurationSec}s MP4 (mock)`);
    return { outputPath: input.outputPath, planPath, totalDurationSec };
  }
}

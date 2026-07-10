import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { Engine, EngineContext, Shot } from '@rev/core';
import type { RenderInput, RenderResult } from './types';

const FPS = 30;

export interface XfadeGraph {
  filter: string;
  outLabel: string;
  totalDurationSec: number;
}

/**
 * Build the filter_complex for n clips: normalize each (scale+pad to the
 * target frame, constant fps, trim to the shot duration), then chain
 * xfade transitions. Offset math: transition k starts at
 * sum(D_0..D_{k-1}) - k*xfade.
 */
export function buildXfadeGraph(
  durations: number[],
  xfadeSec: number,
  width: number,
  height: number,
): XfadeGraph {
  const n = durations.length;
  const norm = durations
    .map(
      (d, i) =>
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},settb=AVTB,` +
        `trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
    )
    .join(';');

  if (n === 1) {
    return { filter: norm.replace('[v0]', '[out]'), outLabel: 'out', totalDurationSec: durations[0] };
  }

  const chains: string[] = [];
  let cumulative = 0;
  let prev = 'v0';
  for (let k = 1; k < n; k++) {
    cumulative += durations[k - 1];
    const offset = cumulative - k * xfadeSec;
    const label = k === n - 1 ? 'out' : `x${k}`;
    chains.push(
      `[${prev}][v${k}]xfade=transition=fade:duration=${xfadeSec.toFixed(3)}:offset=${offset.toFixed(3)}[${label}]`,
    );
    prev = label;
  }

  const total = durations.reduce((a, b) => a + b, 0) - (n - 1) * xfadeSec;
  return {
    filter: `${norm};${chains.join(';')}`,
    outLabel: 'out',
    totalDurationSec: Math.round(total * 100) / 100,
  };
}

function ffmpegBin(): string {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform');
  return ffmpegPath;
}

function runFfmpeg(args: string[], onStderrLine?: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args, { windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      if (onStderrLine) for (const line of text.split(/\r?\n/)) onStderrLine(line);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ...${tail.slice(-500)}`));
    });
  });
}

/** Media duration in seconds, parsed from `ffmpeg -i` stderr. */
export async function probeDurationSec(file: string): Promise<number> {
  let out = '';
  await runFfmpeg(['-i', file], (line) => (out += line + '\n')).catch(() => {
    // ffmpeg exits non-zero when no output file is given — stderr still has the info
  });
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
  if (!m) throw new Error(`could not probe duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * The real Render Engine: trims each clip to its shot duration, chains
 * crossfades, and encodes H.264 at config.resolution. Failed shots are
 * skipped — the cut uses whatever clips exist.
 */
export class FfmpegRenderEngine implements Engine<RenderInput, RenderResult> {
  readonly name = 'render:ffmpeg';

  async process(input: RenderInput, ctx: EngineContext): Promise<RenderResult> {
    const { crossfadeSec, resolution } = ctx.config;
    const usable = input.shots
      .filter((s) => s.status === 'done' && s.clipPath)
      .sort((a, b) => a.order - b.order);
    if (usable.length === 0) {
      throw new Error('No rendered clips available — every shot failed generation.');
    }

    const durations = usable.map((s) => s.durationSec);
    const graph = buildXfadeGraph(durations, crossfadeSec, resolution.width, resolution.height);

    await mkdir(dirname(input.outputPath), { recursive: true });
    const planPath = `${dirname(input.outputPath)}/render-plan.json`;
    await writeFile(
      planPath,
      JSON.stringify(
        {
          engine: this.name,
          resolution,
          crossfadeSec,
          fps: FPS,
          totalDurationSec: graph.totalDurationSec,
          clips: usable.map((s) => ({
            order: s.order,
            room: s.roomType,
            clip: s.clipPath,
            durationSec: s.durationSec,
            motion: s.motionPreset,
          })),
        },
        null,
        2,
      ),
      'utf8',
    );

    const args = [
      ...usable.flatMap((s) => ['-i', s.clipPath as string]),
      '-filter_complex', graph.filter,
      '-map', `[${graph.outLabel}]`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '19',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      '-y', input.outputPath,
    ];

    ctx.logger.info(`Rendering ${usable.length} clips -> ${graph.totalDurationSec}s @${resolution.width}x${resolution.height}`);
    await runFfmpeg(args, (line) => {
      const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const pct = Math.min(99, Math.round((t / graph.totalDurationSec) * 100));
        ctx.progress(pct, `Encoding ${Math.round(t)}s / ${graph.totalDurationSec}s`);
      }
    });

    ctx.progress(100, `Rendered ${usable.length} clips -> ${graph.totalDurationSec}s MP4`);
    return { outputPath: input.outputPath, planPath, totalDurationSec: graph.totalDurationSec };
  }
}

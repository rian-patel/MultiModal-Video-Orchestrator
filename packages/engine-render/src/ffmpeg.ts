import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import type { Engine, EngineContext, Shot } from '@rev/core';
import { CARD_SEC, renderEndCard, renderTitleCard, renderWatermark } from './cards';
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
  // lanczos + a light unsharp: source clips are often below the target frame
  // (Higgsfield DoP is fixed 720p), and the default bicubic stretch is visibly
  // soft at 1080p. Lanczos keeps edges tighter and the mild unsharp restores
  // perceived detail without haloing (0.3 luma amount is below ringing range).
  const norm = durations
    .map(
      (d, i) =>
        `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,unsharp=5:5:0.30:5:5:0.0,` +
        `fps=${FPS},settb=AVTB,` +
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

const ENCODE_ARGS = [
  '-c:v', 'libx264',
  '-preset', 'medium',
  '-crf', '19',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
] as const;

/**
 * The real Render Engine: trims each clip to its shot duration, chains
 * crossfades, and encodes H.264 at config.resolution. Failed shots are
 * skipped — the cut uses whatever clips exist. With `branding`, a title card
 * (address) and end card (agent/contact/logo) join the crossfade chain and a
 * corner logo watermark rides over the tour segment. A 9:16 blur-pad social
 * cut is always derived from the finished master (deterministic + free).
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

    const outDir = dirname(input.outputPath);
    await mkdir(outDir, { recursive: true });

    // Branded cards become extra looped-image inputs in the same xfade chain.
    const branding = input.branding ?? {};
    const titlePng = await renderTitleCard(branding, resolution.width, resolution.height);
    const endPng = await renderEndCard(branding, resolution.width, resolution.height);
    const titlePath = titlePng ? join(outDir, 'title-card.png') : null;
    const endPath = endPng ? join(outDir, 'end-card.png') : null;
    if (titlePng && titlePath) await writeFile(titlePath, titlePng);
    if (endPng && endPath) await writeFile(endPath, endPng);

    const cardInput = (path: string) => ['-loop', '1', '-t', String(CARD_SEC + 1), '-i', path];
    const inputs = [
      ...(titlePath ? cardInput(titlePath) : []),
      ...usable.flatMap((s) => ['-i', s.clipPath as string]),
      ...(endPath ? cardInput(endPath) : []),
    ];
    const durations = [
      ...(titlePath ? [CARD_SEC] : []),
      ...usable.map((s) => s.durationSec),
      ...(endPath ? [CARD_SEC] : []),
    ];
    const graph = buildXfadeGraph(durations, crossfadeSec, resolution.width, resolution.height);

    // Corner watermark over the tour segment only (cards carry their own logo).
    let filter = graph.filter;
    let outLabel = graph.outLabel;
    if (branding.logoPath) {
      const wmPath = join(outDir, 'watermark.png');
      await writeFile(wmPath, await renderWatermark(branding.logoPath, resolution.width));
      const wmIndex = inputs.filter((a) => a === '-i').length;
      inputs.push('-i', wmPath);
      const from = titlePath ? CARD_SEC - crossfadeSec : 0;
      const to = graph.totalDurationSec - (endPath ? CARD_SEC - crossfadeSec : 0);
      const margin = Math.round(resolution.width * 0.025);
      filter +=
        `;[${wmIndex}:v]format=rgba,colorchannelmixer=aa=0.55[wm];` +
        `[${graph.outLabel}][wm]overlay=W-w-${margin}:H-h-${margin}:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[outw]`;
      outLabel = 'outw';
    }

    const planPath = `${outDir}/render-plan.json`;
    await writeFile(
      planPath,
      JSON.stringify(
        {
          engine: this.name,
          resolution,
          crossfadeSec,
          fps: FPS,
          totalDurationSec: graph.totalDurationSec,
          cards: { title: titlePath, end: endPath, cardSec: titlePath || endPath ? CARD_SEC : 0 },
          watermark: Boolean(branding.logoPath),
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
      ...inputs,
      '-filter_complex', filter,
      '-map', `[${outLabel}]`,
      ...ENCODE_ARGS,
      '-y', input.outputPath,
    ];

    ctx.logger.info(`Rendering ${usable.length} clips -> ${graph.totalDurationSec}s @${resolution.width}x${resolution.height}`);
    await runFfmpeg(args, (line) => {
      const m = line.match(/time=(\d+):(\d+):(\d+\.?\d*)/);
      if (m) {
        const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const pct = Math.min(94, Math.round((t / graph.totalDurationSec) * 95));
        ctx.progress(pct, `Encoding ${Math.round(t)}s / ${graph.totalDurationSec}s`);
      }
    });

    // 9:16 social cut: the master centered over a blurred, darkened fill.
    ctx.progress(95, 'Deriving 9:16 social cut');
    const vertical = { width: resolution.height, height: resolution.width };
    const verticalPath = input.outputPath.replace(/\.mp4$/i, '') + '-vertical.mp4';
    await runFfmpeg([
      '-i', input.outputPath,
      '-filter_complex',
      `[0:v]split=2[bg][fg];` +
        `[bg]scale=${vertical.width}:${vertical.height}:force_original_aspect_ratio=increase,` +
        `crop=${vertical.width}:${vertical.height},gblur=sigma=24,eq=brightness=-0.08[b];` +
        `[fg]scale=${vertical.width}:-2[f];[b][f]overlay=(W-w)/2:(H-h)/2`,
      ...ENCODE_ARGS,
      '-y', verticalPath,
    ]);

    ctx.progress(100, `Rendered ${usable.length} clips -> ${graph.totalDurationSec}s MP4 (+9:16 cut)`);
    return { outputPath: input.outputPath, planPath, totalDurationSec: graph.totalDurationSec, verticalPath };
  }
}

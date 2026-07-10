import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { newId } from '@rev/core';
import type { Engine, EngineContext, Shot } from '@rev/core';
import type { VideoGenInput } from './types';

/**
 * Faithful ("Ken Burns") VideoGen engine. Instead of generative image-to-video,
 * it applies a real camera move — a slow pan or zoom — over the ACTUAL photo
 * using FFmpeg's zoompan filter. Every output pixel is sampled from the source
 * image, so no object, room, wall, or fixture can ever be invented. This is the
 * legal-safe default: fidelity is guaranteed by construction, not by prompt.
 *
 * Costs nothing (no API), runs in seconds, and can't fail on content — a shot
 * only fails if FFmpeg itself errors, and failures are isolated per shot.
 */

/** The safe move set. Every one only re-frames real pixels — none invent. */
type KenBurnsMove = 'zoom_in' | 'zoom_out' | 'pan_right' | 'pan_left' | 'tilt_up' | 'tilt_down';

/**
 * Map a storyboard motion preset onto a faithful Ken Burns move. Translational
 * i2v moves (dolly/orbit/crane) that would force a generative model to invent
 * geometry degrade to the nearest honest pan/zoom.
 */
export function kenBurnsMove(motionPreset: string | undefined): KenBurnsMove {
  switch (motionPreset) {
    case 'pullback':
    case 'aerial_pullback':
      return 'zoom_out';
    case 'lateral_glide':
      return 'pan_right';
    case 'pan':
      return 'pan_left';
    case 'crane_up':
    case 'tilt_up':
      return 'tilt_up';
    // push_in, dolly_in, macro_push, orbit, static, and anything else read as a
    // gentle push — the safest, most cinematic default over a still.
    default:
      return 'zoom_in';
  }
}

const FPS = 30;
const SUPERSAMPLE = 2; // render the pan on a 2x canvas for smooth, sharp motion
const ZOOM = 1.12; // peak zoom factor — enough motion, still crisp

/**
 * Build the zoompan expressions for a move. `n` is the output frame count.
 * At constant/peak zoom Z the visible window is base/Z, leaving (base - base/Z)
 * of real pixels to travel across — so pans stay entirely inside the photo.
 */
function zoompanExpr(move: KenBurnsMove, n: number): { z: string; x: string; y: string } {
  const centerX = 'iw/2-(iw/zoom/2)';
  const centerY = 'ih/2-(ih/zoom/2)';
  const p = `on/${Math.max(1, n - 1)}`; // 0 -> 1 across the clip
  switch (move) {
    case 'zoom_in':
      return { z: `min(1+(${ZOOM - 1})*${p},${ZOOM})`, x: centerX, y: centerY };
    case 'zoom_out':
      return { z: `max(${ZOOM}-(${ZOOM - 1})*${p},1)`, x: centerX, y: centerY };
    case 'pan_right':
      return { z: `${ZOOM}`, x: `(iw-iw/zoom)*${p}`, y: centerY };
    case 'pan_left':
      return { z: `${ZOOM}`, x: `(iw-iw/zoom)*(1-${p})`, y: centerY };
    case 'tilt_up':
      return { z: `${ZOOM}`, x: centerX, y: `(ih-ih/zoom)*(1-${p})` };
    case 'tilt_down':
      return { z: `${ZOOM}`, x: centerX, y: `(ih-ih/zoom)*${p}` };
  }
}

/** FFmpeg args to render one Ken Burns clip from a still image. */
export function kenBurnsArgs(
  sourcePath: string,
  outPath: string,
  move: KenBurnsMove,
  durationSec: number,
  width: number,
  height: number,
): string[] {
  const frames = Math.max(2, Math.round(durationSec * FPS));
  const baseW = width * SUPERSAMPLE;
  const baseH = height * SUPERSAMPLE;
  const { z, x, y } = zoompanExpr(move, frames);
  // Cover the supersampled canvas at the output aspect ratio (no distortion,
  // no letterbox), then pan/zoom within it and downscale to the output size.
  const vf =
    `scale=${baseW}:${baseH}:force_original_aspect_ratio=increase,crop=${baseW}:${baseH},` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${FPS},` +
    `format=yuv420p`;
  return [
    '-loop', '1',
    '-i', sourcePath,
    '-t', durationSec.toFixed(3),
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-r', String(FPS),
    '-y', outPath,
  ];
}

function runFfmpeg(args: string[]): Promise<void> {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary');
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => (tail = (tail + c.toString()).slice(-1200)));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${tail.slice(-400)}`)),
    );
  });
}

export class KenBurnsVideoGenEngine implements Engine<VideoGenInput, Shot[]> {
  readonly name = 'videogen:ken-burns';

  async process(input: VideoGenInput, ctx: EngineContext): Promise<Shot[]> {
    const assetById = new Map(input.assets.map((a) => [a.id, a]));
    const clipsDir = join(ctx.workDir, 'clips');
    await mkdir(clipsDir, { recursive: true });
    const { width, height } = ctx.config.resolution;

    const out: Shot[] = [];
    for (let i = 0; i < input.shots.length; i++) {
      const shot: Shot = { ...input.shots[i], status: 'generating' };
      const source = assetById.get(shot.assetId)?.sourcePath;
      const clipPath = join(clipsDir, `shot-${String(shot.order).padStart(2, '0')}.mp4`);
      const move = kenBurnsMove(shot.motionPreset);

      try {
        if (!source) throw new Error('no source asset for shot');
        await mkdir(dirname(clipPath), { recursive: true });
        await runFfmpeg(kenBurnsArgs(source, clipPath, move, shot.durationSec, width, height));
        shot.clipPath = clipPath;
        shot.status = 'done';
        // A deterministic render of the real photo — mark provenance clearly.
        shot.higgsfieldJobId = `kenburns:${move}:${newId('kb')}`;
      } catch (err) {
        ctx.logger.warn(`Shot ${shot.order} (${shot.roomType}) Ken Burns failed: ${err instanceof Error ? err.message : err}`);
        shot.status = 'failed';
      }
      out.push(shot);
      ctx.progress(
        Math.round(((i + 1) / input.shots.length) * 100),
        shot.status === 'done'
          ? `Faithful ${move.replace('_', ' ')} over ${shot.roomType} (${i + 1}/${input.shots.length})`
          : `Shot ${shot.order + 1} (${shot.roomType}) failed — skipped`,
      );
    }

    const ok = out.filter((s) => s.status === 'done').length;
    if (ok === 0) throw new Error(`All ${out.length} Ken Burns renders failed.`);
    ctx.logger.info(`Rendered ${ok}/${out.length} faithful clips (no generative synthesis)`);
    return out;
  }
}

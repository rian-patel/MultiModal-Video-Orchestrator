import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { newId } from '@rev/core';
import type { Engine, EngineContext, RoomType, Shot } from '@rev/core';
import type { VideoGenInput } from './types';

/** A distinct color per room so mock tours are visually followable. */
const ROOM_COLOR: Record<RoomType, string> = {
  exterior_front: '0x7A8CA8',
  foyer: '0xC9B28A',
  living_room: '0xB58E6A',
  kitchen: '0xD8D8CF',
  dining: '0xA3765A',
  primary_bedroom: '0x9AA0B5',
  bedroom: '0x8EA2B8',
  bathroom: '0xDFE6EA',
  office: '0x7F8B73',
  outdoor: '0x6AA877',
  aerial: '0x6B93C4',
  detail: '0x999999',
  other: '0x888888',
};

function ffmpegBin(): string {
  // Hosted workers provide a system ffmpeg via FFMPEG_PATH; ffmpeg-static
  // covers local machines.
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary');
  return ffmpegPath;
}

function makeColorClip(path: string, color: string, durationSec: number): Promise<void> {
  const args = [
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=1280x720:d=${durationSec}:r=30`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p',
    '-y', path,
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin(), args, { windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => (tail = (tail + c.toString()).slice(-1000)));
    proc.on('error', reject);
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`mock clip ffmpeg exited ${code}: ${tail.slice(-300)}`)),
    );
  });
}

/**
 * Mock VideoGen: generates real (playable) solid-color MP4 clips via the
 * bundled ffmpeg instead of calling Higgsfield — so the full pipeline,
 * including the real FFmpeg render, works end-to-end with no API keys.
 */
export class MockVideoGenEngine implements Engine<VideoGenInput, Shot[]> {
  readonly name = 'videogen:mock';

  async process(input: VideoGenInput, ctx: EngineContext): Promise<Shot[]> {
    const { shots } = input;
    const clipsDir = join(ctx.workDir, 'clips');
    await mkdir(clipsDir, { recursive: true });

    const out: Shot[] = [];
    for (let i = 0; i < shots.length; i++) {
      const shot: Shot = { ...shots[i], status: 'generating' };
      const clipPath = join(clipsDir, `shot-${String(shot.order).padStart(2, '0')}.mp4`);
      shot.higgsfieldJobId = newId('hf');

      await mkdir(dirname(clipPath), { recursive: true });
      await makeColorClip(clipPath, ROOM_COLOR[shot.roomType] ?? '0x888888', ctx.config.clipDurationSec);

      shot.clipPath = clipPath;
      shot.status = 'done';
      out.push(shot);
      ctx.progress(
        Math.round(((i + 1) / shots.length) * 100),
        `Animated shot ${i + 1}/${shots.length} (${shot.roomType})`,
      );
    }
    ctx.logger.info(`Generated ${out.length} clips (mock color MP4s)`);
    return out;
  }
}

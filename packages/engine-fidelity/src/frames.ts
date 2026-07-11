import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

/**
 * Extract `count` JPEG frames from a clip: one anchor near the start (≈ the
 * source photo, so the auditor can register the two) and the rest spread
 * across [45%..95%] of `durationSec` — drift accumulates with camera travel,
 * so later frames are the informative ones. Only the first `durationSec`
 * seconds matter: render trims the clip to the shot duration, so anything
 * past it never ships.
 */
export async function extractFrames(
  clipPath: string,
  durationSec: number,
  count: number,
  maxDim: number,
): Promise<Buffer[]> {
  const tail = count - 1; // frames after the anchor, spread 45%..95%
  const fractions =
    count <= 1
      ? [0.95]
      : [0.05, ...Array.from({ length: tail }, (_, i) => (tail === 1 ? 0.95 : 0.45 + (0.5 * i) / (tail - 1)))];
  return Promise.all(
    fractions.map((f) => extractOne(clipPath, Math.max(0, f * durationSec), maxDim)),
  );
}

function extractOne(clipPath: string, atSec: number, maxDim: number): Promise<Buffer> {
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary');
  const args = [
    '-ss', atSec.toFixed(3),
    '-i', clipPath,
    '-frames:v', '1',
    '-vf', `scale='min(${maxDim},iw)':-2`,
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '3',
    'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath as string, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let errTail = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => (errTail = (errTail + c.toString()).slice(-1000)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.length > 0) return resolve(out);
      reject(new Error(`frame extraction ffmpeg exited ${code}: ${errTail.slice(-300)}`));
    });
  });
}

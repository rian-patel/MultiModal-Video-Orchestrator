import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { newId } from '@rev/core';
import type { Asset, Engine, EngineContext } from '@rev/core';
import { MAX_PHOTOS, MIN_PHOTOS, type UploadRequest } from './types';

const THUMB_WIDTH = 320;

/**
 * The real Upload Engine. For each incoming file (already on disk at
 * source.tmpPath, e.g. streamed there by the server's multipart handler):
 *   1. applies EXIF orientation and re-encodes to a normalized high-quality
 *      JPEG in workDir/source/<assetId>.jpg (so every downstream engine can
 *      assume upright, consistent JPEGs),
 *   2. records the true post-rotation dimensions,
 *   3. writes a small preview to workDir/thumbs/<assetId>.jpg.
 */
export class LocalUploadEngine implements Engine<UploadRequest, Asset[]> {
  readonly name = 'upload:local';

  async process(input: UploadRequest, ctx: EngineContext): Promise<Asset[]> {
    const { sources } = input;
    if (sources.length < MIN_PHOTOS || sources.length > MAX_PHOTOS) {
      throw new Error(
        `Expected ${MIN_PHOTOS}-${MAX_PHOTOS} photos, received ${sources.length}.`,
      );
    }

    const sourceDir = join(ctx.workDir, 'source');
    const thumbsDir = join(ctx.workDir, 'thumbs');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(thumbsDir, { recursive: true });

    const assets: Asset[] = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (!s.tmpPath) {
        throw new Error(`"${s.originalName}": no file data received (tmpPath missing).`);
      }

      const id = newId('asset');
      const sourcePath = join(sourceDir, `${id}.jpg`);
      const thumbPath = join(thumbsDir, `${id}.jpg`);

      try {
        // .rotate() with no args applies the EXIF orientation tag.
        const info = await sharp(s.tmpPath)
          .rotate()
          .jpeg({ quality: 92 })
          .toFile(sourcePath);

        await sharp(sourcePath)
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toFile(thumbPath);

        assets.push({
          id,
          sourcePath,
          thumbPath,
          originalName: s.originalName,
          width: info.width,
          height: info.height,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`"${s.originalName}" could not be processed as an image: ${reason}`);
      }

      ctx.progress(
        Math.round(((i + 1) / sources.length) * 100),
        `Processed ${s.originalName} (${assets[i].width}x${assets[i].height})`,
      );
    }

    ctx.logger.info(`Ingested ${assets.length} photos into ${sourceDir}`);
    return assets;
  }
}

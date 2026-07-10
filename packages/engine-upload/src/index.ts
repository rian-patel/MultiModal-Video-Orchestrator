import { newId } from '@rev/core';
import type { Asset, Engine, EngineContext } from '@rev/core';
import { MAX_PHOTOS, MIN_PHOTOS, type UploadRequest } from './types';

export * from './types';
export * from './local';

/**
 * MVP mock: validates the 10–40 photo constraint and turns each source into an
 * Asset. The real UploadEngine will also copy files into workDir/source, read
 * real dimensions (sharp), fix EXIF orientation, and make thumbnails.
 */
export class MockUploadEngine implements Engine<UploadRequest, Asset[]> {
  readonly name = 'upload:mock';

  async process(input: UploadRequest, ctx: EngineContext): Promise<Asset[]> {
    const { sources } = input;
    if (sources.length < MIN_PHOTOS || sources.length > MAX_PHOTOS) {
      throw new Error(
        `Expected ${MIN_PHOTOS}-${MAX_PHOTOS} photos, received ${sources.length}.`,
      );
    }

    const assets: Asset[] = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      assets.push({
        id: newId('asset'),
        sourcePath: s.tmpPath ?? `${ctx.workDir}/source/${s.originalName}`,
        originalName: s.originalName,
        width: s.width ?? 1920,
        height: s.height ?? 1080,
      });
      ctx.progress(Math.round(((i + 1) / sources.length) * 100), `Ingested ${s.originalName}`);
    }

    ctx.logger.info(`Validated & ingested ${assets.length} photos`);
    return assets;
  }
}

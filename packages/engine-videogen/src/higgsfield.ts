import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapWithConcurrency } from '@rev/core';
import type { Engine, EngineContext, Shot } from '@rev/core';
import type { VideoGenInput } from './types';

export interface HiggsfieldOptions {
  /** Platform API credentials, "key:secret" (docs.higgsfield.ai). */
  apiKey?: string;
  /** Model path, e.g. "higgsfield-ai/dop/standard". */
  model?: string;
  baseUrl?: string;
  maxConcurrency?: number;
  pollIntervalMs?: number;
  /** Give up polling one clip after this long. */
  maxPollMs?: number;
  /** Full submit->poll->download attempts per shot. */
  maxAttempts?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface SubmitResponse {
  request_id?: string;
  id?: string;
}

interface StatusResponse {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';
  video?: { url?: string } | null;
  video_url?: string;
}

/**
 * Real VideoGen engine against the Higgsfield platform REST API
 * (https://platform.higgsfield.ai — fal-style queue):
 *   POST /{model}  { image_url, prompt, duration }  -> { request_id }
 *   GET  /requests/{id}/status                      -> { status, video.url }
 * Per shot: image -> data URI -> submit -> poll -> download to workDir/clips.
 * Failures are isolated per shot (status 'failed'); the run only fails when
 * every clip fails.
 */
export class HiggsfieldVideoGenEngine implements Engine<VideoGenInput, Shot[]> {
  readonly name = 'videogen:higgsfield';
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxConcurrency: number;
  private pollIntervalMs: number;
  private maxPollMs: number;
  private maxAttempts: number;
  private fetch: typeof fetch;

  constructor(opts: HiggsfieldOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.HIGGSFIELD_API_KEY ?? '';
    this.model = opts.model ?? process.env.HIGGSFIELD_MODEL ?? 'higgsfield-ai/dop/standard';
    this.baseUrl = (opts.baseUrl ?? 'https://platform.higgsfield.ai').replace(/\/+$/, '');
    // Higgsfield starter plans allow max 2 concurrent jobs (observed live).
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    this.maxPollMs = opts.maxPollMs ?? 6 * 60_000;
    this.maxAttempts = opts.maxAttempts ?? 2;
    this.fetch = opts.fetchImpl ?? fetch;
  }

  async process(input: VideoGenInput, ctx: EngineContext): Promise<Shot[]> {
    if (!this.apiKey) {
      throw new Error('HIGGSFIELD_API_KEY is not set — cannot generate video clips.');
    }
    const assetById = new Map(input.assets.map((a) => [a.id, a]));
    const clipsDir = join(ctx.workDir, 'clips');
    await mkdir(clipsDir, { recursive: true });

    let done = 0;
    const shots = await mapWithConcurrency(input.shots, this.maxConcurrency, async (shot) => {
      const result = await this.generateShot(shot, assetById.get(shot.assetId)?.sourcePath, clipsDir, ctx);
      done++;
      ctx.progress(
        Math.round((done / input.shots.length) * 100),
        result.status === 'done'
          ? `Animated shot ${shot.order + 1}/${input.shots.length} (${shot.roomType})`
          : `Shot ${shot.order + 1} (${shot.roomType}) FAILED — will be skipped in the final cut`,
      );
      return result;
    });

    const ok = shots.filter((s) => s.status === 'done').length;
    if (ok === 0) {
      throw new Error(`All ${shots.length} clip generations failed — cannot produce a video.`);
    }
    ctx.logger.info(`Generated ${ok}/${shots.length} clips via ${this.model}`);
    return shots;
  }

  private async generateShot(
    shot: Shot,
    sourcePath: string | undefined,
    clipsDir: string,
    ctx: EngineContext,
  ): Promise<Shot> {
    const out: Shot = { ...shot, status: 'generating' };
    if (!sourcePath) {
      ctx.logger.error(`Shot ${shot.order}: no source asset found`);
      return { ...out, status: 'failed' };
    }

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const requestId = await this.submit(sourcePath, shot, ctx);
        out.higgsfieldJobId = requestId;
        const videoUrl = await this.pollUntilDone(requestId);
        const clipPath = join(clipsDir, `shot-${String(shot.order).padStart(2, '0')}.mp4`);
        await this.download(videoUrl, clipPath);
        return { ...out, clipPath, status: 'done' };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Shot ${shot.order} attempt ${attempt}/${this.maxAttempts} failed: ${reason}`);
      }
    }
    return { ...out, status: 'failed' };
  }

  private async submit(sourcePath: string, shot: Shot, ctx: EngineContext): Promise<string> {
    // Local-first app: photos aren't publicly reachable, so send a data URI
    // (fal-style APIs accept these for image_url).
    const image = await readFile(sourcePath);
    const res = await this.fetch(`${this.baseUrl}/${this.model}`, {
      method: 'POST',
      headers: {
        authorization: `Key ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        image_url: `data:image/jpeg;base64,${image.toString('base64')}`,
        prompt: shot.prompt ?? 'Slow cinematic dolly-in. Photoreal, no people.',
        duration: Math.max(1, Math.ceil(ctx.config.clipDurationSec)),
      }),
    });
    if (!res.ok) {
      throw new Error(`submit failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as SubmitResponse;
    const id = body.request_id ?? body.id;
    if (!id) throw new Error('submit response had no request_id');
    return id;
  }

  private async pollUntilDone(requestId: string): Promise<string> {
    const deadline = Date.now() + this.maxPollMs;
    while (true) {
      const res = await this.fetch(`${this.baseUrl}/requests/${requestId}/status`, {
        headers: { authorization: `Key ${this.apiKey}` },
      });
      if (!res.ok) throw new Error(`status poll failed: HTTP ${res.status}`);
      const body = (await res.json()) as StatusResponse;

      if (body.status === 'completed') {
        const url = body.video?.url ?? body.video_url;
        if (!url) throw new Error('job completed but no video URL in response');
        return url;
      }
      if (body.status === 'failed' || body.status === 'nsfw') {
        throw new Error(`generation ${body.status}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${Math.round(this.maxPollMs / 1000)}s`);
      }
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
  }

  private async download(url: string, clipPath: string): Promise<void> {
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`clip download failed: HTTP ${res.status}`);
    await mkdir(dirname(clipPath), { recursive: true });
    await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
  }
}

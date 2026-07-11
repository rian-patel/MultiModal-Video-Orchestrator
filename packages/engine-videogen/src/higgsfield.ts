import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapWithConcurrency } from '@rev/core';
import type { Engine, EngineContext, PipelineConfig, Shot } from '@rev/core';
import type { VideoGenInput } from './types';

/** v2 DoP model variants (POST /v1/image2video/dop `params.model`). */
export type DopModel = 'dop-turbo' | 'dop-lite' | 'dop-preview';
/** Seedance variants (POST /v1/image2video/seedance) — native 1080p. */
export type SeedanceModel = 'seedance_pro' | 'seedance_lite';
export type VideoModel = DopModel | SeedanceModel;

export interface HiggsfieldOptions {
  /** Platform API credentials, "key:secret" (docs.higgsfield.ai). */
  apiKey?: string;
  /** Model: dop-* (720p, motion-strength lever) or seedance_* (native 1080p,
   * prompt-driven camera). Unknown/legacy values normalize to the default. */
  model?: string;
  baseUrl?: string;
  /**
   * Motion strength 0..1 sent with every motion preset. THE fidelity lever:
   * lower strength = less camera travel = less occluded geometry the model
   * must synthesize = less room to hallucinate. 0.3 verified live (2026-07):
   * faithful reproduction of the living-room photo, drift confined to
   * door-reveal details, vs. a fabricated kitchen+person at default strength.
   */
  motionStrength?: number;
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
  /** v2 job-set id — accepted by the legacy /requests/{id}/status route. */
  id?: string;
  request_id?: string;
}

interface UploadLinkResponse {
  upload_url?: string;
  public_url?: string;
}

interface StatusResponse {
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw';
  video?: { url?: string } | null;
  video_url?: string;
}

const DEFAULT_MODEL: VideoModel = 'dop-turbo';
const DOP_MODELS: ReadonlySet<string> = new Set(['dop-turbo', 'dop-lite', 'dop-preview']);
const SEEDANCE_MODELS: ReadonlySet<string> = new Set(['seedance_pro', 'seedance_lite']);

/**
 * Our motion presets (see engine-prompt/templates.ts) mapped onto Higgsfield's
 * motion catalog (GET /v1/motions — ids are stable UUIDs). Only low-travel,
 * non-destructive camera moves; anything unknown falls back to Dolly In.
 */
export const MOTION_IDS: Record<string, string> = {
  push_in: '81ca2cd2-05db-4222-9ba0-a32e5185adfb', // Dolly In
  dolly_in: '81ca2cd2-05db-4222-9ba0-a32e5185adfb', // Dolly In
  macro_push: 'fbcbec5b-30f8-4b17-ba6e-8e8d5b265562', // Zoom In
  pullback: '12ac8798-5370-4801-91a6-f1acb425fc4a', // Dolly Out
  aerial_pullback: '12ac8798-5370-4801-91a6-f1acb425fc4a', // Dolly Out
  lateral_glide: '15ddc007-4723-42c1-8446-2af69af4879f', // Dolly Right
  pan: '71f0f8bc-0e5d-4d32-b34f-bd74a5e3cba8', // Dolly Left
  tilt_up: '2c9af101-fe7a-4299-91f3-e44431a0576f', // Tilt up
  crane_up: '68af9add-43ea-4261-a706-16b640fdcff9', // Crane Up
  orbit: 'a85cb3f2-f2be-4ee2-b3b9-808fc6a81acc', // Arc Right
  static: 'fa3ddb7c-53ee-4383-aa17-97ae65f180e5', // Static
};
const FALLBACK_MOTION_ID = MOTION_IDS.dolly_in;

/**
 * Real VideoGen engine against the Higgsfield platform v2 API
 * (https://platform.higgsfield.ai, schema probed live 2026-07):
 *   POST /files/generate-upload-url { content_type } -> { upload_url, public_url }
 *   PUT  {upload_url} (raw image bytes)              -> (image now hosted)
 *   POST /v1/image2video/dop      (dop-* models)     -> { id, jobs: [...] }
 *   POST /v1/image2video/seedance (seedance_* models)-> { id, jobs: [...] }
 *   GET  /requests/{id}/status (either id)           -> { status, video.url }
 *
 * Model families and their fidelity levers:
 * - dop-*: fixed 1280x720 output. `motions: [{id, strength}]` — low strength
 *   (0..1) caps camera travel, THE anti-hallucination lever on this family.
 *   No duration param (~5s clips).
 * - seedance_*: native 1080p (crisper end product; ~3.5x cost, faster wall
 *   time observed). No motion catalog / strength — the camera move rides in
 *   the prompt (`prompts` ARRAY; a bare `prompt` is silently dropped and a
 *   promptless run invented a person — verified live). camera_fixed:false +
 *   fidelity-first prompt + the fidelity audit are the controls here.
 *
 * (image_url must be a hosted URL ≤2083 chars, NOT a data URI — 422
 * url_too_long.) Failures are isolated per shot (status 'failed'); the run
 * only fails when every clip fails.
 */
export class HiggsfieldVideoGenEngine implements Engine<VideoGenInput, Shot[]> {
  readonly name = 'videogen:higgsfield';
  private apiKey: string;
  private model: VideoModel;
  private baseUrl: string;
  private motionStrength: number;
  private maxConcurrency: number;
  private pollIntervalMs: number;
  private maxPollMs: number;
  private maxAttempts: number;
  private fetch: typeof fetch;

  constructor(opts: HiggsfieldOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.HIGGSFIELD_API_KEY ?? '';
    const rawModel = opts.model ?? process.env.HIGGSFIELD_MODEL ?? DEFAULT_MODEL;
    // Legacy configs may still say e.g. "higgsfield-ai/dop/standard" — the v2
    // endpoints reject anything outside their enums, so normalize.
    this.model = (
      DOP_MODELS.has(rawModel) || SEEDANCE_MODELS.has(rawModel) ? rawModel : DEFAULT_MODEL
    ) as VideoModel;
    this.baseUrl = (opts.baseUrl ?? 'https://platform.higgsfield.ai').replace(/\/+$/, '');
    const rawStrength = opts.motionStrength ?? Number(process.env.HIGGSFIELD_MOTION_STRENGTH ?? 0.3);
    this.motionStrength = Math.min(1, Math.max(0, Number.isFinite(rawStrength) ? rawStrength : 0.3));
    // Higgsfield starter plans allow max 2 concurrent jobs (observed live).
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.pollIntervalMs = opts.pollIntervalMs ?? 5_000;
    // dop generation is usually a few min but has been seen near ~16 min under
    // load; keep the ceiling well above that so a slow-but-fine clip is never
    // falsely timed out (a timeout no longer resubmits, but it does lose the
    // paid clip). See generateShot for the retry split.
    this.maxPollMs = opts.maxPollMs ?? 20 * 60_000;
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
    ctx.logger.info(
      SEEDANCE_MODELS.has(this.model)
        ? `Generated ${ok}/${shots.length} clips via ${this.model} (native 1080p, prompt-driven camera)`
        : `Generated ${ok}/${shots.length} clips via ${this.model} @ strength ${this.motionStrength}`,
    );
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

    // Phase 1 — obtain a request_id (upload image + submit). RETRYABLE: a
    // failure here (e.g. a transient 502 from the CDN upload endpoint) happens
    // before any billable job exists, so retrying costs nothing.
    let requestId: string | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        requestId = await this.submit(sourcePath, shot, ctx.config);
        break;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        ctx.logger.warn(`Shot ${shot.order} submit attempt ${attempt}/${this.maxAttempts} failed: ${reason}`);
      }
    }
    if (!requestId) return { ...out, status: 'failed' };
    out.higgsfieldJobId = requestId;

    // Phase 2 — poll + download. NOT retried: the job is now billable, so a
    // poll timeout must never resubmit (that would double-charge). One shot →
    // at most one billed clip, regardless of maxAttempts.
    try {
      const videoUrl = await this.pollUntilDone(requestId);
      const clipPath = join(clipsDir, `shot-${String(shot.order).padStart(2, '0')}.mp4`);
      await this.download(videoUrl, clipPath);
      return { ...out, clipPath, status: 'done' };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Shot ${shot.order} generation failed (job ${requestId}, not resubmitted): ${reason}`);
      return { ...out, status: 'failed' };
    }
  }

  private async submit(sourcePath: string, shot: Shot, config: PipelineConfig): Promise<string> {
    // Local-first app: photos aren't publicly reachable, and the platform
    // rejects data URIs (422 url_too_long, 2083-char cap). So upload the image
    // to Higgsfield's CDN first and submit the returned hosted URL.
    const imageUrl = await this.uploadImage(sourcePath);
    const prompt = shot.prompt ?? 'A slow, subtle push-in with minimal travel. Photoreal, no people.';
    const seedance = SEEDANCE_MODELS.has(this.model);

    // Both bodies disable the platform's prompt "enhancer" — it embellishes
    // the prompt and is a source of invented detail (fidelity over creativity
    // for real-estate accuracy).
    const params: Record<string, unknown> = seedance
      ? {
          // Seedance (native 1080p). Traps verified live 2026-07: a bare
          // `prompt` field is SILENTLY DROPPED (must be `prompts` array; the
          // promptless clip invented a person), and the DoP motion catalog is
          // rejected ("Motion not found") — the camera move rides in the
          // prompt text. camera_fixed:false makes the camera carry the motion
          // instead of the model animating the scene contents.
          prompts: [prompt],
          input_image: { type: 'image_url', image_url: imageUrl },
          model: this.model,
          resolution: config.resolution.height >= 1080 ? '1080' : '720',
          duration: Math.min(12, Math.max(3, Math.round(config.clipDurationSec))),
          aspect_ratio: '16:9',
          camera_fixed: false,
          enhance_prompt: false,
        }
      : {
          prompt,
          input_images: [{ type: 'image_url', image_url: imageUrl }],
          model: this.model,
          // Low strength caps camera travel (fidelity); the preset picks the
          // move direction the Prompt engine chose for this room.
          motions: [
            { id: MOTION_IDS[shot.motionPreset ?? ''] ?? FALLBACK_MOTION_ID, strength: this.motionStrength },
          ],
          enhance_prompt: false,
        };

    const res = await this.fetch(`${this.baseUrl}/v1/image2video/${seedance ? 'seedance' : 'dop'}`, {
      method: 'POST',
      headers: {
        authorization: `Key ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ params }),
    });
    if (!res.ok) {
      throw new Error(`submit failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as SubmitResponse;
    const id = body.id ?? body.request_id;
    if (!id) throw new Error('submit response had no job id');
    return id;
  }

  /**
   * Two-step upload to the Higgsfield CDN (matches the official SDK):
   * ask for a presigned URL, PUT the bytes to it, return the public URL.
   */
  private async uploadImage(sourcePath: string): Promise<string> {
    const bytes = await readFile(sourcePath);
    const linkRes = await this.fetch(`${this.baseUrl}/files/generate-upload-url`, {
      method: 'POST',
      headers: {
        authorization: `Key ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content_type: 'image/jpeg' }),
    });
    if (!linkRes.ok) {
      throw new Error(`upload-url failed: HTTP ${linkRes.status} ${(await linkRes.text()).slice(0, 200)}`);
    }
    const { upload_url, public_url } = (await linkRes.json()) as UploadLinkResponse;
    if (!upload_url || !public_url) {
      throw new Error('upload-url response missing upload_url/public_url');
    }
    // Presigned PUT: auth is embedded in the URL, so only Content-Type is sent.
    const putRes = await this.fetch(upload_url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: bytes,
    });
    if (!putRes.ok) {
      throw new Error(`image upload PUT failed: HTTP ${putRes.status}`);
    }
    return public_url;
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

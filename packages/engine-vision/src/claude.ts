import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { mapWithConcurrency } from '@rev/core';
import type { Asset, Engine, EngineContext, VisionResult } from '@rev/core';
import { LIGHTINGS, ROOM_ANALYSIS_SCHEMA, ROOM_TYPES, type RoomAnalysis } from './schema';

export interface ClaudeVisionOptions {
  /** Defaults to SDK credential resolution (ANTHROPIC_API_KEY etc.). */
  apiKey?: string;
  model?: string;
  /** Parallel API calls. */
  maxConcurrency?: number;
  /** Long-edge downscale before sending — classification doesn't need full res. */
  maxImageDim?: number;
}

const SYSTEM_PROMPT = `You are a real-estate photography analyst for an automated cinematic video tour generator.
For each property photo you receive, classify the room/area, describe it vividly (your description feeds a video-generation prompt), note its lighting, suggest one cinematic camera move, and score its suitability for a marketing video.
Guidance:
- "exterior_front" is the street-facing facade; "outdoor" is yards/patios/pools; "aerial" is drone shots.
- "primary_bedroom" only when clearly the main suite (size, ensuite, king bed); otherwise "bedroom".
- "detail" is a close-up of a material or fixture rather than a whole space.
- If the image is not a property photo at all, use "other" and a qualityScore below 0.2.`;

/**
 * The real Vision Engine: one Claude call per photo (structured output), with
 * bounded concurrency and per-image fallback — a photo that can't be analyzed
 * gets a conservative default rather than failing the whole run.
 */
export class ClaudeVisionEngine implements Engine<Asset[], VisionResult[]> {
  readonly name = 'vision:claude';
  private client: Anthropic;
  private model: string;
  private maxConcurrency: number;
  private maxImageDim: number;

  constructor(opts: ClaudeVisionOptions = {}) {
    this.client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      maxRetries: 3, // 429/5xx retried with backoff by the SDK
    });
    this.model = opts.model ?? 'claude-opus-4-8';
    this.maxConcurrency = opts.maxConcurrency ?? 4;
    this.maxImageDim = opts.maxImageDim ?? 1280;
  }

  async process(assets: Asset[], ctx: EngineContext): Promise<VisionResult[]> {
    let done = 0;
    const results = await mapWithConcurrency(assets, this.maxConcurrency, async (asset) => {
      const result = await this.analyzeOne(asset, ctx);
      done++;
      ctx.progress(
        Math.round((done / assets.length) * 100),
        `Analyzed ${asset.originalName} -> ${result.roomType} (q=${result.qualityScore})`,
      );
      return result;
    });
    ctx.logger.info(`Claude classified ${results.length} images`);
    return results;
  }

  private async analyzeOne(asset: Asset, ctx: EngineContext): Promise<VisionResult> {
    try {
      // Downscale: room classification doesn't need full resolution, and
      // smaller images cost fewer input tokens per call.
      const jpeg = await sharp(asset.sourcePath)
        .resize({ width: this.maxImageDim, height: this.maxImageDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        output_config: {
          format: {
            type: 'json_schema',
            schema: ROOM_ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') },
              },
              { type: 'text', text: 'Analyze this property photo.' },
            ],
          },
        ],
      });

      if (response.stop_reason === 'refusal') {
        throw new Error('model refused the request');
      }
      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      const analysis = sanitize(JSON.parse(text) as RoomAnalysis);

      return { assetId: asset.id, ...analysis };
    } catch (err) {
      // Per-image isolation: log and return a conservative default so one bad
      // image (or transient API failure after retries) doesn't kill the run.
      const reason = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Vision failed for ${asset.originalName}: ${reason}`);
      return {
        assetId: asset.id,
        roomType: 'other',
        description: 'interior space',
        features: [],
        lighting: 'mixed',
        suggestedMove: 'slow dolly-in',
        qualityScore: 0.3,
      };
    }
  }
}

/** Clamp/validate model output against our domain types. */
function sanitize(a: RoomAnalysis): RoomAnalysis {
  return {
    roomType: ROOM_TYPES.includes(a.roomType) ? a.roomType : 'other',
    description: String(a.description ?? 'interior space').slice(0, 300),
    features: (a.features ?? []).slice(0, 4).map(String),
    lighting: LIGHTINGS.includes(a.lighting) ? a.lighting : 'mixed',
    suggestedMove: String(a.suggestedMove ?? 'slow dolly-in').slice(0, 120),
    qualityScore: Math.min(1, Math.max(0, Number(a.qualityScore) || 0)),
  };
}


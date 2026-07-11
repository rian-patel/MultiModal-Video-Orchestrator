import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { mapWithConcurrency } from '@rev/core';
import type { Engine, EngineContext, Shot } from '@rev/core';
import { extractFrames } from './frames';
import { FIDELITY_VERDICT_SCHEMA, type FidelityVerdict } from './schema';
import type { FidelityInput } from './types';

/** The slice of the Anthropic client we use — injectable for tests. */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      stop_reason?: string | null;
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export interface FidelityOptions {
  /** Defaults to SDK credential resolution (ANTHROPIC_API_KEY etc.). */
  apiKey?: string;
  model?: string;
  /** Parallel clip audits (each sends 1 source image + frameCount frames). */
  maxConcurrency?: number;
  /** Frames sampled per clip. */
  frameCount?: number;
  /** Long-edge downscale for the source photo and frames. */
  maxImageDim?: number;
  /** Injectable for tests. */
  clientImpl?: MessagesClient;
  extractFramesImpl?: typeof extractFrames;
}

const SYSTEM_PROMPT = `You are a fidelity auditor for AI-generated real-estate marketing videos.
The FIRST image is the authoritative source photo of a property. Every following image is a frame sampled from a short AI-generated camera-move clip created from that photo. Real-estate marketing must not misrepresent the property, so your job is to catch material fabrications.
Return verdict "drift" when any frame:
- contains a person or animal;
- adds, removes, or replaces furniture, appliances, or fixtures within the area visible in the source photo;
- changes the room's layout or structure (walls, doorways, windows, stairs);
- reveals adjacent space whose contents CONTRADICT what the source photo shows there (e.g. the source shows a bathroom through that doorway but the frame shows a kitchen).
Return verdict "faithful" otherwise. Expected generative artifacts that are NOT drift: lower resolution or softness, mild lighting/color shifts, small distortions of text, logos or artwork, a slightly different crop, and plausible continuations of partially visible objects at frame edges or through doorways.
IMPORTANT on adjacent space: the camera move reveals areas the source only shows as small slivers through doorways — inspect those slivers closely (they are easy to miss) before claiming an object is not in the source. The first sampled frame is taken near the clip's start and is nearly identical to the source photo; use it to register the spatial correspondence between the source and the later frames, including which doorway leads where. An elaboration of a partially visible area that stays consistent with the sliver and with the room type is faithful; only a contradiction or a clearly misleading addition (a person, a fireplace or luxury feature where none exists, a different room type) is drift.
Judge materiality: would this difference mislead a home buyer about what the property contains? List each concrete problem; leave the list empty when faithful.`;

/**
 * The fidelity backstop: after VideoGen, each generated clip is compared to
 * its source photo by Claude (frames sampled across the clip). A clip that
 * materially misrepresents the property (invented furniture/rooms/people) is
 * marked 'failed' so Render skips it — a shorter, honest tour beats shipping
 * a hallucination. Resume regenerates failed shots, so a drifted clip gets a
 * fresh roll on the next attempt.
 *
 * Failure isolation is FAIL-OPEN: if the audit itself errors (API hiccup,
 * unreadable file), the clip is kept and left unflagged so a later resume
 * re-audits it — validation is a safety net and must never destroy a paid
 * clip on its own failure.
 */
export class ClaudeFidelityEngine implements Engine<FidelityInput, Shot[]> {
  readonly name = 'fidelity:claude';
  private client: MessagesClient;
  private model: string;
  private maxConcurrency: number;
  private frameCount: number;
  private maxImageDim: number;
  private extractFrames: typeof extractFrames;

  constructor(opts: FidelityOptions = {}) {
    // The real SDK's create() signature is stricter than the injectable
    // MessagesClient slice (typed params vs Record) — safe to widen here.
    this.client =
      opts.clientImpl ??
      (new Anthropic({
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        maxRetries: 3, // 429/5xx retried with backoff by the SDK
      }) as unknown as MessagesClient);
    this.model = opts.model ?? 'claude-opus-4-8';
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    // 1 anchor frame near t=0 + 3 spread over the clip's back half.
    this.frameCount = opts.frameCount ?? 4;
    // 1568 = the largest long edge Claude vision uses; door-reveal audits hinge
    // on tiny slivers in the source photo, so don't shrink below that.
    this.maxImageDim = opts.maxImageDim ?? 1568;
    this.extractFrames = opts.extractFramesImpl ?? extractFrames;
  }

  async process(input: FidelityInput, ctx: EngineContext): Promise<Shot[]> {
    const assetById = new Map(input.assets.map((a) => [a.id, a]));
    const toCheck = input.shots.filter((s) => s.status === 'done' && s.clipPath && !s.fidelityChecked);
    if (toCheck.length === 0) {
      ctx.progress(100, 'No new clips to audit');
      return input.shots;
    }

    let done = 0;
    const audited = new Map<number, Shot>();
    await mapWithConcurrency(toCheck, this.maxConcurrency, async (shot) => {
      const result = await this.auditOne(shot, assetById.get(shot.assetId)?.sourcePath, ctx);
      audited.set(shot.order, result);
      done++;
      ctx.progress(
        Math.round((done / toCheck.length) * 100),
        result.status === 'done'
          ? `Fidelity check ${done}/${toCheck.length}: shot ${shot.order + 1} (${shot.roomType}) OK`
          : `Shot ${shot.order + 1} (${shot.roomType}) FAILED the fidelity check — dropped from the cut`,
      );
    });

    const out = input.shots.map((s) => audited.get(s.order) ?? s);
    const dropped = [...audited.values()].filter((s) => s.status !== 'done').length;
    ctx.logger.info(
      dropped === 0
        ? `All ${toCheck.length} audited clips faithful`
        : `${dropped}/${toCheck.length} clips dropped for property drift (resume regenerates them)`,
    );
    return out;
  }

  private async auditOne(shot: Shot, sourcePath: string | undefined, ctx: EngineContext): Promise<Shot> {
    try {
      if (!sourcePath) throw new Error('no source asset for shot');
      const sourceJpeg = await sharp(sourcePath)
        .resize({ width: this.maxImageDim, height: this.maxImageDim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      const frames = await this.extractFrames(shot.clipPath!, shot.durationSec, this.frameCount, this.maxImageDim);

      const toImageBlock = (buf: Buffer) => ({
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: buf.toString('base64') },
      });
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        output_config: {
          format: {
            type: 'json_schema',
            schema: FIDELITY_VERDICT_SCHEMA as unknown as Record<string, unknown>,
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              toImageBlock(sourceJpeg),
              ...frames.map(toImageBlock),
              {
                type: 'text',
                text: `Source photo first, then ${frames.length} frames sampled across the generated clip in time order. Audit the frames against the source.`,
              },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal') throw new Error('model refused the request');
      const text = response.content.find((b) => b.type === 'text')?.text ?? '';
      const { verdict, problems } = JSON.parse(text) as FidelityVerdict;

      if (verdict === 'drift') {
        ctx.logger.warn(
          `Shot ${shot.order} (${shot.roomType}) drifted from the source photo: ${
            problems.slice(0, 3).join('; ') || 'unspecified fabrication'
          }`,
        );
        // No fidelityChecked flag: the shot goes back to 'pending' on resume
        // and its regenerated clip will be audited fresh.
        return { ...shot, status: 'failed' };
      }
      return { ...shot, fidelityChecked: true };
    } catch (err) {
      // Fail-open: an audit error must not fail a paid clip. Left unflagged so
      // a later resume re-audits it.
      const reason = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`Fidelity audit failed for shot ${shot.order} — keeping the clip unaudited: ${reason}`);
      return shot;
    }
  }
}

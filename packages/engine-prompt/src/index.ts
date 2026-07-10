import type { Engine, EngineContext, Shot, VisionResult } from '@rev/core';
import { FIDELITY_CONSTRAINT, presetFromMove, ROOM_PROMPTS, safeMovePhrase } from './templates';

export * from './templates';

export interface PromptInput {
  shots: Shot[];
  vision: VisionResult[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Composes each shot's image-to-video prompt, fidelity-first:
 *   "Camera: <safe move>. <Lighting> light; <mood>. <fidelity constraint>"
 *
 * Deliberately carries NO declarative description of the scene's contents — the
 * source image is the sole authority on what's in the room, and naming
 * furniture or adjacent rooms in the prompt is what leads a generative model to
 * invent them (the dining-table hallucination). The prompt now supplies only
 * the camera move (from a neutral, non-directional palette) and mood.
 *
 * Vision's photo-specific suggestion still selects the motion PRESET (which the
 * faithful Ken Burns engine maps to a real pan/zoom, and which picks the safe
 * phrasing here) — but Vision's free-text, which may name a destination like
 * "toward the dining room", never reaches the prompt.
 */
export class TemplatePromptEngine implements Engine<PromptInput, Shot[]> {
  readonly name = 'prompt:template';

  async process(input: PromptInput, ctx: EngineContext): Promise<Shot[]> {
    const visionById = new Map(input.vision.map((v) => [v.assetId, v]));
    const ordered = [...input.shots].sort((a, b) => a.order - b.order);

    const occurrence = new Map<string, number>();
    let prevPreset: string | undefined;
    let prevRoom: string | undefined;

    const out = ordered.map((shot) => {
      const spec = ROOM_PROMPTS[shot.roomType];
      const v = visionById.get(shot.assetId);
      const occ = occurrence.get(shot.roomType) ?? 0;
      occurrence.set(shot.roomType, occ + 1);

      // Motion preset: Vision's photo-specific suggestion wins; otherwise
      // rotate through the room's variants for variety on repeats.
      let preset = v?.suggestedMove?.trim()
        ? presetFromMove(v.suggestedMove.trim(), shot.roomType)
        : spec.variants[occ % spec.variants.length].motion;

      // Editing rule: two identical moves in a row on the same room feels
      // repetitive — switch the later shot to a differing variant.
      if (preset === prevPreset && shot.roomType === prevRoom) {
        const alt = spec.variants.filter((x) => x.motion !== preset)[occ % Math.max(1, spec.variants.length - 1)];
        if (alt) preset = alt.motion;
      }
      prevPreset = preset;
      prevRoom = shot.roomType;

      const lighting = v?.lighting ?? 'natural';
      // Content comes from the image, never the prompt.
      const prompt = `Camera: ${safeMovePhrase(preset)}. ${cap(lighting)} light; ${spec.mood}. ${FIDELITY_CONSTRAINT}`;

      return { ...shot, prompt, motionPreset: preset };
    });

    ctx.progress(100, `Wrote ${out.length} fidelity-first prompts`);
    return out;
  }
}

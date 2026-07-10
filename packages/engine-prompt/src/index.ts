import type { Engine, EngineContext, Shot, VisionResult } from '@rev/core';
import { presetFromMove, ROOM_PROMPTS, STYLE_SUFFIX } from './templates';

export * from './templates';

export interface PromptInput {
  shots: Shot[];
  vision: VisionResult[];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "spacious kitchen" -> "A spacious kitchen"; "a blank frame" -> "A blank frame". */
function withArticle(desc: string): string {
  const trimmed = desc.trim().replace(/\.+$/, '');
  if (/^(a|an|the)\s/i.test(trimmed)) return cap(trimmed);
  const article = /^[aeiou]/i.test(trimmed) ? 'An' : 'A';
  return `${article} ${trimmed}`;
}

/**
 * Composes each shot's image-to-video prompt:
 *   "<Scene>. Camera: <move>. <Lighting> light; <mood>. <style suffix>"
 *
 * The camera move prefers Vision's photo-specific suggestion (mapped onto a
 * Higgsfield motion preset); room-type variants provide fallbacks, rotate
 * across repeat rooms, and break up identical back-to-back moves within the
 * same room. Swappable for an LLM prompt writer behind the same interface.
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

      // Camera move: Vision's photo-specific suggestion wins; otherwise
      // rotate through the room's variants for variety on repeats.
      let move = v?.suggestedMove?.trim();
      let preset: string;
      if (move) {
        preset = presetFromMove(move, shot.roomType);
      } else {
        const variant = spec.variants[occ % spec.variants.length];
        move = variant.move;
        preset = variant.motion;
      }

      // Editing rule: two identical moves in a row on the same room feels
      // repetitive — switch the later shot to a differing variant.
      if (preset === prevPreset && shot.roomType === prevRoom) {
        const alts = spec.variants.filter((x) => x.motion !== preset);
        if (alts.length > 0) {
          const alt = alts[occ % alts.length];
          move = alt.move;
          preset = alt.motion;
        }
      }
      prevPreset = preset;
      prevRoom = shot.roomType;

      const scene = withArticle(v?.description ?? shot.roomType.replace(/_/g, ' '));
      const lighting = v?.lighting ?? 'natural';
      const prompt = `${scene}. Camera: ${move}. ${cap(lighting)} light; ${spec.mood}. ${STYLE_SUFFIX}`;

      return { ...shot, prompt, motionPreset: preset };
    });

    ctx.progress(100, `Wrote ${out.length} cinematic prompts`);
    return out;
  }
}

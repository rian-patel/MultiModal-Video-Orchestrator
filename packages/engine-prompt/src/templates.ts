import type { RoomType } from '@rev/core';

/**
 * Fidelity constraint appended to every image-to-video prompt. For real-estate
 * use the model must NOT embellish the property, so this is a hard instruction
 * to preserve the source exactly — the single most important lever we have on
 * the generative (cinematic) path, since the DoP endpoint has no negative-prompt
 * field. Paired with removing all declarative scene description from the prompt
 * (see index.ts): the image supplies the content, the prompt supplies only the
 * camera move + mood.
 */
export const FIDELITY_CONSTRAINT =
  'Preserve the real space exactly: do not add, remove, move, or invent any furniture, ' +
  'objects, rooms, doorways, windows, walls, or fixtures; keep the existing layout and ' +
  'every existing object unchanged. Photoreal, subtle natural camera motion, minimal ' +
  'camera travel, no people, no on-screen text, no new scenery.';

/**
 * Neutral, non-directional camera phrasing keyed by motion preset. Deliberately
 * avoids "toward the X" targets and large translational moves — a prompt that
 * names a destination invites the model to synthesize (and thus fabricate) it.
 */
export const SAFE_MOVE_PHRASE: Record<string, string> = {
  push_in: 'a slow, subtle push-in with minimal travel',
  dolly_in: 'a slow, subtle push-in with minimal travel',
  macro_push: 'a slow, subtle push-in on the existing detail',
  pullback: 'a slow, gentle pull-back with minimal travel',
  aerial_pullback: 'a slow, gentle pull-back with minimal travel',
  lateral_glide: 'a slow lateral glide',
  pan: 'a slow, gentle pan',
  tilt_up: 'a slow, gentle upward tilt',
  crane_up: 'a slow, gentle upward tilt',
  orbit: 'a subtle slow drift',
  static: 'an almost-static hold with the faintest drift',
};

export const safeMovePhrase = (preset: string): string =>
  SAFE_MOVE_PHRASE[preset] ?? 'a slow, subtle push-in with minimal travel';

export interface PromptVariant {
  /** Higgsfield motion preset id. */
  motion: string;
  /** Default camera phrase, used when Vision didn't suggest one (or for variety). */
  move: string;
}

export interface RoomPromptSpec {
  /** Mood clause woven into the prompt (lowercase, no trailing period). */
  mood: string;
  /** Ordered variants — rotated per occurrence of the room in a tour. */
  variants: PromptVariant[];
}

export const ROOM_PROMPTS: Record<RoomType, RoomPromptSpec> = {
  exterior_front: {
    mood: 'crisp curb appeal, welcoming and grand',
    variants: [
      { motion: 'push_in', move: 'slow push-in toward the front entrance' },
      { motion: 'lateral_glide', move: 'gentle lateral glide across the facade' },
    ],
  },
  foyer: {
    mood: 'bright, open first impression',
    variants: [
      { motion: 'tilt_up', move: 'elegant tilt-up revealing the entry' },
      { motion: 'dolly_in', move: 'slow dolly-in through the entryway' },
    ],
  },
  living_room: {
    mood: 'warm, inviting and airy',
    variants: [
      { motion: 'dolly_in', move: 'smooth dolly-in toward the seating area' },
      { motion: 'lateral_glide', move: 'slow lateral glide across the living space' },
      { motion: 'orbit', move: 'gentle arc around the seating area' },
    ],
  },
  kitchen: {
    mood: 'refined, luxurious and pristine',
    variants: [
      { motion: 'lateral_glide', move: 'slow glide along the island and countertops' },
      { motion: 'push_in', move: 'steady push-in over the island toward the backsplash' },
    ],
  },
  dining: {
    mood: 'elegant and convivial',
    variants: [
      { motion: 'orbit', move: 'gentle orbit around the dining table' },
      { motion: 'push_in', move: 'slow push-in toward the table setting' },
    ],
  },
  primary_bedroom: {
    mood: 'serene, airy and luxurious',
    variants: [
      { motion: 'push_in', move: 'soft push-in toward the bed and windows' },
      { motion: 'lateral_glide', move: 'calm lateral drift across the suite' },
    ],
  },
  bedroom: {
    mood: 'calm and comfortable',
    variants: [
      { motion: 'dolly_in', move: 'slow dolly-in into the room' },
      { motion: 'pan', move: 'soft pan across the room' },
    ],
  },
  bathroom: {
    mood: 'clean, spa-like calm with glossy surfaces',
    variants: [
      { motion: 'pan', move: 'slow pan across the vanity and fixtures' },
      { motion: 'push_in', move: 'gentle push-in toward the tub' },
    ],
  },
  office: {
    mood: 'focused and quietly productive',
    variants: [
      { motion: 'push_in', move: 'subtle push-in toward the desk' },
      { motion: 'pan', move: 'slow pan across the workspace' },
    ],
  },
  outdoor: {
    mood: 'expansive golden-hour resort feel',
    variants: [
      { motion: 'crane_up', move: 'rising crane move revealing the yard' },
      { motion: 'pullback', move: 'slow pull-back revealing the full grounds' },
      { motion: 'lateral_glide', move: 'wide lateral glide across the outdoor space' },
    ],
  },
  aerial: {
    mood: 'sweeping establishing grandeur',
    variants: [
      { motion: 'aerial_pullback', move: 'slow aerial pull-back revealing the property' },
      { motion: 'orbit', move: 'wide aerial orbit around the property' },
    ],
  },
  detail: {
    mood: 'tactile, high-end material focus',
    variants: [{ motion: 'macro_push', move: 'macro slow push on the detail' }],
  },
  other: {
    mood: 'understated and clean',
    variants: [
      { motion: 'dolly_in', move: 'slow dolly-in through the space' },
      { motion: 'pan', move: 'gentle pan across the space' },
    ],
  },
};

/**
 * Map a free-text camera phrase (usually Vision's photo-specific suggestion)
 * onto a Higgsfield motion preset. Order matters: most specific first.
 */
export function presetFromMove(move: string, roomType: RoomType): string {
  const m = move.toLowerCase();
  if (/aerial/.test(m) && /pull|zoom out/.test(m)) return 'aerial_pullback';
  if (/pull[- ]?back|pull[- ]?away|retreat|zoom[- ]?out/.test(m)) return 'pullback';
  if (/crane|rising|ascend|\brise\b/.test(m)) return 'crane_up';
  if (/orbit|circle|\barc\b/.test(m)) return 'orbit';
  if (/tilt/.test(m)) return 'tilt_up';
  if (/glide|lateral|track|along/.test(m)) return 'lateral_glide';
  if (/\bpan\b|panning/.test(m)) return 'pan';
  if (/macro|close[- ]?up/.test(m)) return 'macro_push';
  if (/push/.test(m)) return 'push_in';
  if (/dolly|toward|into|through/.test(m)) return 'dolly_in';
  if (/static|hold/.test(m)) return 'static';
  return ROOM_PROMPTS[roomType].variants[0].motion;
}

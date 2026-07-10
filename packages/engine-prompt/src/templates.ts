import type { RoomType } from '@rev/core';

/**
 * Shared cinematic grammar appended to every prompt. Keeps image-to-video
 * output stable: no invented people, no text artifacts, smooth motion.
 */
export const STYLE_SUFFIX =
  'Photoreal, smooth stabilized camera, cinematic 24fps motion, gentle parallax, no people, no on-screen text.';

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

import type { Asset, Engine, EngineContext, Lighting, RoomType, VisionResult } from '@rev/core';

// A plausible spread of rooms so downstream ordering/selection has something to
// chew on. The real ClaudeVisionEngine replaces this with a vision API call
// that returns roomType + description + lighting + quality per image.
const ROOM_CYCLE: RoomType[] = [
  'exterior_front', 'foyer', 'living_room', 'kitchen', 'dining',
  'primary_bedroom', 'bedroom', 'bathroom', 'office', 'outdoor',
  'living_room', 'bedroom', 'bathroom', 'aerial',
];

const PROFILE: Record<RoomType, { desc: string; features: string[]; move: string }> = {
  exterior_front: { desc: 'front exterior with manicured landscaping', features: ['facade', 'driveway', 'garden'], move: 'slow push-in on the entrance' },
  foyer: { desc: 'bright entry foyer with a staircase', features: ['staircase', 'chandelier'], move: 'reveal tilt up the staircase' },
  living_room: { desc: 'open-plan living room with large windows', features: ['sofa', 'fireplace', 'large windows'], move: 'smooth dolly toward the windows' },
  kitchen: { desc: 'modern kitchen with a marble island', features: ['island', 'pendant lights', 'stainless appliances'], move: 'glide along the island' },
  dining: { desc: 'elegant dining area', features: ['dining table', 'pendant light'], move: 'orbit around the table' },
  primary_bedroom: { desc: 'spacious primary bedroom', features: ['king bed', 'ensuite', 'natural light'], move: 'gentle push toward the window' },
  bedroom: { desc: 'comfortable bedroom', features: ['bed', 'closet'], move: 'slow dolly-in' },
  bathroom: { desc: 'spa-like bathroom', features: ['soaking tub', 'vanity'], move: 'slow pan across the vanity' },
  office: { desc: 'home office with built-ins', features: ['desk', 'shelving'], move: 'subtle push-in' },
  outdoor: { desc: 'backyard with a patio', features: ['patio', 'pool', 'landscaping'], move: 'rising crane over the yard' },
  aerial: { desc: 'aerial view of the property', features: ['rooftop', 'lot', 'neighborhood'], move: 'slow aerial pull-back' },
  detail: { desc: 'architectural detail', features: ['texture', 'material'], move: 'macro slow push' },
  other: { desc: 'interior space', features: [], move: 'slow dolly-in' },
};

const LIGHTINGS: Lighting[] = ['bright', 'warm', 'mixed', 'dim'];

/** Deterministic 0..1 from an id so runs are reproducible. */
function seeded(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MockVisionEngine implements Engine<Asset[], VisionResult[]> {
  readonly name = 'vision:mock';

  async process(assets: Asset[], ctx: EngineContext): Promise<VisionResult[]> {
    const out: VisionResult[] = [];
    for (let i = 0; i < assets.length; i++) {
      const a = assets[i];
      const roomType = ROOM_CYCLE[i % ROOM_CYCLE.length];
      const p = PROFILE[roomType];
      const r = seeded(a.id);
      out.push({
        assetId: a.id,
        roomType,
        description: p.desc,
        features: p.features,
        lighting: LIGHTINGS[Math.floor(r * LIGHTINGS.length)],
        suggestedMove: p.move,
        qualityScore: Number((0.55 + r * 0.45).toFixed(3)),
      });
      await sleep(8); // pretend it's an API call
      ctx.progress(Math.round(((i + 1) / assets.length) * 100), `Analyzed ${a.originalName} -> ${roomType}`);
    }
    ctx.logger.info(`Classified ${out.length} images`);
    return out;
  }
}

import type { Lighting, RoomType } from '@rev/core';

export const ROOM_TYPES: RoomType[] = [
  'exterior_front', 'foyer', 'living_room', 'kitchen', 'dining',
  'bedroom', 'primary_bedroom', 'bathroom', 'office', 'outdoor',
  'aerial', 'detail', 'other',
];

export const LIGHTINGS: Lighting[] = ['bright', 'warm', 'dim', 'mixed'];

/** What Claude returns per image (VisionResult minus assetId). */
export interface RoomAnalysis {
  roomType: RoomType;
  description: string;
  features: string[];
  lighting: Lighting;
  suggestedMove: string;
  qualityScore: number;
}

/**
 * JSON schema for structured outputs (output_config.format). Guarantees the
 * response parses into RoomAnalysis — no free-text JSON extraction needed.
 * Structured outputs require additionalProperties:false and full `required`.
 */
export const ROOM_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    roomType: {
      type: 'string',
      enum: ROOM_TYPES,
      description: 'The room or area type this photo shows',
    },
    description: {
      type: 'string',
      description:
        'One vivid sentence fragment describing the space, e.g. "sunlit open-plan kitchen with a marble island". No trailing period.',
    },
    features: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 4 notable selling features visible in the photo',
    },
    lighting: { type: 'string', enum: LIGHTINGS },
    suggestedMove: {
      type: 'string',
      description:
        'A single cinematic camera move that would suit this photo, e.g. "slow dolly-in toward the windows"',
    },
    qualityScore: {
      type: 'number',
      description:
        'Suitability for a marketing video, 0 to 1. Penalize blur, clutter, poor framing, dark exposure. A photo that does not show a property at all scores below 0.2.',
    },
  },
  required: ['roomType', 'description', 'features', 'lighting', 'suggestedMove', 'qualityScore'],
  additionalProperties: false,
} as const;

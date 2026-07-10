import type { RoomType } from '@rev/core';

/** Canonical order of a real-estate walkthrough. Lower = earlier in the tour. */
export const ROOM_PRIORITY: Record<RoomType, number> = {
  exterior_front: 0,
  foyer: 1,
  living_room: 2,
  kitchen: 3,
  dining: 4,
  primary_bedroom: 5,
  bedroom: 6,
  bathroom: 7,
  office: 8,
  outdoor: 9,
  aerial: 10,
  detail: 11,
  other: 12,
};

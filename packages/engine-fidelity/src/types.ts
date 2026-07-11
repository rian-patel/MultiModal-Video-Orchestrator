import type { Asset, Shot } from '@rev/core';

/** Fidelity validation compares each shot's generated clip to its source image. */
export interface FidelityInput {
  shots: Shot[];
  assets: Asset[];
}

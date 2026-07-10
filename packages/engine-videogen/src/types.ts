import type { Asset, Shot } from '@rev/core';

/** VideoGen needs each shot's source image, so assets ride along. */
export interface VideoGenInput {
  shots: Shot[];
  assets: Asset[];
}

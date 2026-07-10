/** One incoming photo. In Phase 1 tmpPath points at the uploaded temp file. */
export interface SourceFile {
  originalName: string;
  tmpPath?: string;
  width?: number;
  height?: number;
}

export interface UploadRequest {
  sources: SourceFile[];
}

export const MIN_PHOTOS = 10;
export const MAX_PHOTOS = 40;

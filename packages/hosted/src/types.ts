// Narrow slices of the Supabase client the adapters actually use, so tests
// can inject stubs and the adapters never depend on supabase-js types
// directly. The real client satisfies these structurally.

export interface DbResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
}

/** The query-builder subset we use: upsert, insert, select, and update-eq. */
export interface TableLike {
  upsert(values: Record<string, unknown>): PromiseLike<DbResult>;
  insert(values: Record<string, unknown>): PromiseLike<DbResult>;
  update(values: Record<string, unknown>): UpdateLike;
  select(columns?: string): SelectLike;
}

export interface UpdateLike {
  eq(column: string, value: unknown): PromiseLike<DbResult>;
}

export interface SelectLike {
  eq(column: string, value: unknown): SelectLike;
  order(column: string, opts?: { ascending?: boolean }): SelectLike;
  maybeSingle(): PromiseLike<DbResult<Record<string, unknown>>>;
  then<T>(onfulfilled: (r: DbResult<Record<string, unknown>[]>) => T): PromiseLike<T>;
}

export interface StorageBucketLike {
  upload(
    path: string,
    body: ArrayBuffer | Uint8Array | Blob,
    opts?: { contentType?: string; upsert?: boolean },
  ): Promise<{ error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<{ data: { signedUrl: string } | null; error: { message: string } | null }>;
}

/** The client slice: `.from(table)` and `.storage.from(bucket)`. */
export interface SupabaseLike {
  from(table: string): TableLike;
  storage: { from(bucket: string): StorageBucketLike };
}

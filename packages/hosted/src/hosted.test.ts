import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Project } from '@rev/core';
import { SupabaseBlobStore } from './blobStore';
import { artifactKey, rebaseProjectPaths } from './paths';
import { SupabaseProjectStore } from './projectStore';
import { SupabaseProgressSink } from './progressSink';
import { ArtifactSync } from './sync';
import type { DbResult, SelectLike, SupabaseLike } from './types';

// ---------- stub client ----------

interface Row extends Record<string, unknown> {}

function fakeSupabase() {
  const tables = new Map<string, Row[]>();
  const objects = new Map<string, Uint8Array>(); // "<bucket>/<path>" -> bytes

  const client: SupabaseLike = {
    from(table) {
      const rows = tables.get(table) ?? tables.set(table, []).get(table)!;
      return {
        async upsert(values: Row): Promise<DbResult> {
          const i = rows.findIndex((r) => r.id === values.id);
          if (i >= 0) rows[i] = values;
          else rows.push(values);
          return { data: null, error: null };
        },
        async insert(values: Row): Promise<DbResult> {
          rows.push(values);
          return { data: null, error: null };
        },
        select(): SelectLike {
          let filtered = [...rows];
          const sel: SelectLike = {
            eq(col, val) {
              filtered = filtered.filter((r) => r[col] === val);
              return sel;
            },
            order() {
              return sel;
            },
            async maybeSingle() {
              return { data: filtered[0] ?? null, error: null };
            },
            then(onfulfilled) {
              return Promise.resolve({ data: filtered, error: null }).then(onfulfilled);
            },
          };
          return sel;
        },
      };
    },
    storage: {
      from(bucket) {
        return {
          async upload(path, body) {
            const bytes =
              body instanceof Uint8Array ? body : new Uint8Array(await (body as Blob).arrayBuffer());
            objects.set(`${bucket}/${path}`, bytes);
            return { error: null };
          },
          async download(path) {
            const bytes = objects.get(`${bucket}/${path}`);
            if (!bytes) return { data: null, error: { message: 'not found' } };
            return { data: new Blob([Buffer.from(bytes)]), error: null };
          },
          async createSignedUrl(path) {
            return { data: { signedUrl: `https://signed.example/${bucket}/${path}` }, error: null };
          },
        };
      },
    },
  };
  return { client, tables, objects };
}

function makeProject(workDir: string): Project {
  return {
    id: 'proj_h1',
    createdAt: new Date().toISOString(),
    targetDurationSec: 30,
    stage: 'generating',
    assets: [
      {
        id: 'a1',
        sourcePath: join(workDir, 'source', 'a1.jpg'),
        thumbPath: join(workDir, 'thumbs', 'a1.jpg'),
        originalName: 'kitchen.jpg',
        width: 100,
        height: 100,
      },
    ],
    vision: [],
    shots: [
      { order: 0, assetId: 'a1', roomType: 'kitchen', durationSec: 5, clipPath: join(workDir, 'clips', 'shot-00.mp4'), status: 'done' },
      { order: 1, assetId: 'a1', roomType: 'kitchen', durationSec: 5, status: 'failed' },
    ],
    branding: { agentName: 'Jane', logoPath: join(workDir, 'branding', 'logo.png') },
  };
}

// ---------- tests ----------

test('project store round-trips the document with promoted columns', async () => {
  const { client, tables } = fakeSupabase();
  const store = new SupabaseProjectStore(client);
  const project = makeProject('/tmp/x');
  project.lastError = 'boom';

  await store.upsert(project, 'user-1');
  const row = tables.get('projects')![0];
  assert.equal(row.stage, 'generating');
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.last_error, 'boom');

  const loaded = await store.load('proj_h1');
  assert.ok(loaded);
  assert.equal(loaded!.userId, 'user-1');
  assert.deepEqual(loaded!.project, project);

  assert.equal(await store.load('proj_nope'), null);
});

test('rebaseProjectPaths remaps every path family onto the new workDir', () => {
  const project = makeProject('C:/old/machine/projects/proj_h1');
  project.outputPath = 'C:/old/machine/projects/proj_h1/output/tour.mp4';
  project.verticalPath = 'C:/old/machine/projects/proj_h1/output/tour-vertical.mp4';

  const rebased = rebaseProjectPaths(project, '/scratch/proj_h1');
  assert.equal(rebased.assets[0].sourcePath, join('/scratch/proj_h1', 'source', 'a1.jpg'));
  assert.equal(rebased.assets[0].thumbPath, join('/scratch/proj_h1', 'thumbs', 'a1.jpg'));
  assert.equal(rebased.shots[0].clipPath, join('/scratch/proj_h1', 'clips', 'shot-00.mp4'));
  assert.equal(rebased.shots[1].clipPath, undefined, 'failed shot keeps no clip path');
  assert.equal(rebased.branding?.logoPath, join('/scratch/proj_h1', 'branding', 'logo.png'));
  assert.equal(rebased.outputPath, join('/scratch/proj_h1', 'output', 'tour.mp4'));
  assert.equal(rebased.verticalPath, join('/scratch/proj_h1', 'output', 'tour-vertical.mp4'));
  // input untouched
  assert.match(project.assets[0].sourcePath, /old.machine/);
});

test('artifact sync push uploads existing artifacts once; pull restores what a resume needs', async () => {
  const scratch1 = await mkdtemp(join(tmpdir(), 'rev-hosted-'));
  const project = makeProject(scratch1);
  for (const sub of ['source', 'thumbs', 'clips', 'branding']) await mkdir(join(scratch1, sub), { recursive: true });
  await writeFile(project.assets[0].sourcePath, 'src-bytes');
  await writeFile(project.assets[0].thumbPath!, 'thumb-bytes');
  await writeFile(project.shots[0].clipPath!, 'clip-bytes');
  await writeFile(project.branding!.logoPath!, 'logo-bytes');

  const { client, objects } = fakeSupabase();
  const blob = new SupabaseBlobStore(client, 'projects');
  const sync = new ArtifactSync(blob, 'user-1');

  await sync.push(project);
  assert.ok(objects.has('projects/user-1/proj_h1/source/a1.jpg'));
  assert.ok(objects.has('projects/user-1/proj_h1/clips/shot-00.mp4'));
  assert.ok(objects.has('projects/user-1/proj_h1/branding/logo.png'));
  const count = objects.size;
  await sync.push(project); // second push: nothing re-uploaded, nothing throws
  assert.equal(objects.size, count);

  // Fresh worker: hydrate into a new scratch dir.
  const scratch2 = await mkdtemp(join(tmpdir(), 'rev-hosted-'));
  const rebased = rebaseProjectPaths(project, scratch2);
  const sync2 = new ArtifactSync(blob, 'user-1');
  await sync2.pull(rebased);
  assert.equal(await readFile(rebased.assets[0].sourcePath, 'utf8'), 'src-bytes');
  assert.equal(await readFile(rebased.shots[0].clipPath!, 'utf8'), 'clip-bytes');
  assert.equal(await readFile(rebased.branding!.logoPath!, 'utf8'), 'logo-bytes');
  assert.ok(!existsSync(join(scratch2, 'thumbs', 'a1.jpg')), 'thumbs are not pulled (pipeline never reads them)');
});

test('pull fails loudly when an essential artifact is missing from storage', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'rev-hosted-'));
  const project = rebaseProjectPaths(makeProject('/gone'), scratch);
  const { client } = fakeSupabase(); // empty storage
  const sync = new ArtifactSync(new SupabaseBlobStore(client, 'projects'), 'user-1');
  await assert.rejects(sync.pull(project), /download .*a1\.jpg failed/);
});

test('progress sink writes rows keyed to the run', async () => {
  const { client, tables } = fakeSupabase();
  const sink = new SupabaseProgressSink(client);
  await sink.emit(
    { runId: 'run_1', projectId: 'proj_h1', userId: 'user-1' },
    { type: 'progress', data: { pct: 50, stage: 'videogen', msg: 'halfway' } },
  );
  const row = tables.get('run_events')![0];
  assert.equal(row.run_id, 'run_1');
  assert.equal(row.type, 'progress');
  assert.deepEqual(row.data, { pct: 50, stage: 'videogen', msg: 'halfway' });
});

test('artifactKey builds the user-scoped storage layout', () => {
  assert.equal(
    artifactKey('user-1', 'proj_h1', 'C:/scratch/clips/shot-00.mp4', 'clips'),
    'user-1/proj_h1/clips/shot-00.mp4',
  );
});

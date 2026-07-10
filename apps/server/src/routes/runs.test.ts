import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@rev/core';
import { buildApp } from '../app';
import { parseByteRange } from './runs';

async function makeCompletedProject(projectsDir: string, id: string, bytes: string): Promise<void> {
  const workDir = join(projectsDir, id);
  await mkdir(join(workDir, 'output'), { recursive: true });
  const outputPath = join(workDir, 'output', 'tour.mp4');
  await writeFile(outputPath, bytes);
  const project: Project = {
    id,
    createdAt: new Date().toISOString(),
    targetDurationSec: 45,
    stage: 'complete',
    assets: [],
    vision: [],
    shots: [],
    outputPath,
  };
  await writeFile(join(workDir, 'project.json'), JSON.stringify(project), 'utf8');
}

test('parseByteRange handles the forms <video> seeking sends', () => {
  assert.equal(parseByteRange(undefined, 10), null);
  assert.deepEqual(parseByteRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange('bytes=8-', 10), { start: 8, end: 9 });
  assert.deepEqual(parseByteRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(parseByteRange('bytes=0-999', 10), { start: 0, end: 9 }, 'end clamped to size');
  assert.equal(parseByteRange('bytes=99-', 10), 'invalid');
  assert.equal(parseByteRange('bytes=5-2', 10), 'invalid');
  assert.equal(parseByteRange('bytes=-0', 10), 'invalid');
  assert.equal(parseByteRange('bytes=-', 10), 'invalid');
});

test('video route streams, honors Range, and labels downloads', async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), 'rev-server-'));
  const app = await buildApp({ projectsDir });
  await makeCompletedProject(projectsDir, 'proj_video', '0123456789');

  let res = await app.inject({ url: '/api/projects/proj_nope/video' });
  assert.equal(res.statusCode, 404);

  res = await app.inject({ url: '/api/projects/proj_video/video' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'video/mp4');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.rawPayload.toString(), '0123456789');

  res = await app.inject({
    url: '/api/projects/proj_video/video',
    headers: { range: 'bytes=2-5' },
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  assert.equal(res.rawPayload.toString(), '2345');

  res = await app.inject({
    url: '/api/projects/proj_video/video',
    headers: { range: 'bytes=99-' },
  });
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers['content-range'], 'bytes */10');

  res = await app.inject({ url: '/api/projects/proj_video/video?download' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['content-disposition']), /attachment; filename="tour-45s\.mp4"/);

  await app.close();
});

test('review run pauses at the storyboard; PATCH reorders, drops, and re-paces', async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), 'rev-server-'));
  const app = await buildApp({ projectsDir });

  // Demo run with review -> must stop at 'review', not run to completion.
  let res = await app.inject({
    method: 'POST',
    url: '/api/runs',
    payload: { targetDurationSec: 30, review: true },
  });
  assert.equal(res.statusCode, 202);
  const { runId } = res.json() as { runId: string };

  let status = 'running';
  let projectId = '';
  for (let i = 0; i < 100 && status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const snap = (await app.inject({ url: `/api/runs/${runId}` })).json() as {
      status: string;
      projectId?: string;
    };
    status = snap.status;
    projectId = snap.projectId ?? '';
  }
  assert.equal(status, 'review', 'run parks at the review checkpoint');
  assert.ok(projectId);

  // The storyboard is readable and fully prompted.
  res = await app.inject({ url: `/api/projects/${projectId}/storyboard` });
  assert.equal(res.statusCode, 200);
  const board = res.json() as {
    stage: string;
    totalDurationSec: number;
    shots: { assetId: string; prompt?: string; order: number }[];
  };
  assert.equal(board.stage, 'prompted');
  assert.equal(board.shots.length, 7, '30s demo tour plans 7 clips');
  assert.ok(board.shots.every((s) => s.prompt), 'every shot arrives prompted');
  assert.equal(board.totalDurationSec, 30);

  // Reorder only (same count) -> still paced to exactly 30s.
  const ids = board.shots.map((s) => s.assetId);
  const reversed = [...ids].reverse();
  res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}/storyboard`,
    payload: { assetIds: reversed },
  });
  assert.equal(res.statusCode, 200);
  let updated = res.json() as typeof board;
  assert.deepEqual(updated.shots.map((s) => s.assetId), reversed);
  assert.deepEqual(updated.shots.map((s) => s.order), reversed.map((_, i) => i));
  assert.equal(updated.totalDurationSec, 30, 'same clip count keeps the exact target');

  // Drop one -> 6 full-length clips: 6*5 - 5*0.75 = 26.25s.
  res = await app.inject({
    method: 'PATCH',
    url: `/api/projects/${projectId}/storyboard`,
    payload: { assetIds: reversed.slice(0, -1) },
  });
  assert.equal(res.statusCode, 200);
  updated = res.json() as typeof board;
  assert.equal(updated.shots.length, 6);
  assert.equal(updated.totalDurationSec, 26.25, 'shorter cut, full-length clips');

  // Validation: unknown ids, duplicates, empty.
  for (const bad of [['nope'], [reversed[0], reversed[0]], []]) {
    res = await app.inject({
      method: 'PATCH',
      url: `/api/projects/${projectId}/storyboard`,
      payload: { assetIds: bad },
    });
    assert.equal(res.statusCode, 400, `assetIds ${JSON.stringify(bad)} must be rejected`);
  }

  // Demo assets have no thumbnails.
  res = await app.inject({ url: `/api/projects/${projectId}/thumb/whatever` });
  assert.equal(res.statusCode, 404);

  await app.close();
});

test('storyboard editing is locked outside the review checkpoint', async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), 'rev-server-'));
  const app = await buildApp({ projectsDir });
  await makeCompletedProject(projectsDir, 'proj_locked', 'x');

  let res = await app.inject({ url: '/api/projects/proj_locked/storyboard' });
  assert.equal(res.statusCode, 409, 'completed demo fixture has no shots -> no storyboard');

  res = await app.inject({
    method: 'PATCH',
    url: '/api/projects/proj_locked/storyboard',
    payload: { assetIds: ['a'] },
  });
  assert.equal(res.statusCode, 409, 'PATCH refused outside the prompted stage');

  await app.close();
});

test('resume route validates project state before starting a run', async () => {
  const projectsDir = await mkdtemp(join(tmpdir(), 'rev-server-'));
  const app = await buildApp({ projectsDir });
  await makeCompletedProject(projectsDir, 'proj_done', 'x');

  let res = await app.inject({ method: 'POST', url: '/api/projects/proj_nope/resume' });
  assert.equal(res.statusCode, 404);

  res = await app.inject({ method: 'POST', url: '/api/projects/proj_done/resume' });
  assert.equal(res.statusCode, 409, 'completed projects have nothing to resume');

  // path traversal shapes never reach the filesystem
  res = await app.inject({ method: 'POST', url: '/api/projects/..%2F..%2Fetc/resume' });
  assert.equal(res.statusCode, 404);

  await app.close();
});

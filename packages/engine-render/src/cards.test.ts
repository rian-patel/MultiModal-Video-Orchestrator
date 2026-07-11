import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { renderEndCard, renderTitleCard, renderWatermark } from './cards';

async function dims(png: Buffer): Promise<{ w: number; h: number }> {
  const m = await sharp(png).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

/** Tiny solid logo fixture on disk. */
async function makeLogo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rev-cards-'));
  const path = join(dir, 'logo.png');
  const png = await sharp({
    create: { width: 400, height: 200, channels: 4, background: { r: 200, g: 30, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  await writeFile(path, png);
  return path;
}

test('title card renders at frame size; empty branding renders nothing', async () => {
  const png = await renderTitleCard({ address: '128 Maple Grove Lane', agentName: 'Jane Smith' }, 1920, 1080);
  assert.ok(png, 'card produced when there is content');
  assert.deepEqual(await dims(png as Buffer), { w: 1920, h: 1080 });

  assert.equal(await renderTitleCard({}, 1920, 1080), null, 'no content -> no card');
  assert.equal(await renderTitleCard({ phone: '555' }, 1920, 1080), null, 'contact alone is not a title');
});

test('card text is XML-escaped (addresses with & <> quotes must not break SVG)', async () => {
  const png = await renderTitleCard(
    { address: `12 O'Brien & Sons Rd <Unit "B">`, agentName: 'A & B Realty' },
    640,
    360,
  );
  assert.ok(png, 'hostile characters survive');
  assert.deepEqual(await dims(png as Buffer), { w: 640, h: 360 });
});

test('end card: contact only, and logo composited when given', async () => {
  const noLogo = await renderEndCard({ agentName: 'Jane Smith', phone: '555-0100', email: 'j@x.com' }, 640, 360);
  assert.ok(noLogo);
  assert.deepEqual(await dims(noLogo as Buffer), { w: 640, h: 360 });

  const logoPath = await makeLogo();
  const withLogo = await renderEndCard({ agentName: 'Jane Smith', logoPath }, 640, 360);
  assert.ok(withLogo);
  assert.deepEqual(await dims(withLogo as Buffer), { w: 640, h: 360 });
  // The composite must actually contain the red logo pixels near the center-top.
  const { data, info } = await sharp(withLogo as Buffer)
    .extract({ left: 300, top: 100, width: 40, height: 40 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let sawRed = false;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] > 150 && data[i + 1] < 90) sawRed = true;
  }
  assert.ok(sawRed, 'logo pixels present on the end card');

  assert.equal(await renderEndCard({}, 640, 360), null, 'no content -> no card');
});

test('watermark is resized relative to the frame width', async () => {
  const logoPath = await makeLogo();
  const wm = await renderWatermark(logoPath, 1920);
  const { w } = await dims(wm);
  assert.ok(w <= Math.round(1920 * 0.083), `watermark width ${w} fits the corner budget`);
  assert.ok(w > 100, 'still visibly sized');
});

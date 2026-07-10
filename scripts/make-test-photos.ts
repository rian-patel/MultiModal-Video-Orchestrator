// Generates 12 test JPEGs with varied dimensions + colors, including one with
// an EXIF orientation tag to verify the Upload Engine's .rotate() handling.
// Usage: npx tsx scripts/make-test-photos.ts [outDir]   (default: test-photos/)
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const outDir = process.argv[2] ?? join(import.meta.dirname, '..', 'test-photos');
await mkdir(outDir, { recursive: true });

const specs = [
  { name: 'front_exterior.jpg', w: 2400, h: 1600, rgb: [120, 140, 180] },
  { name: 'foyer.jpg', w: 2000, h: 1333, rgb: [200, 180, 150] },
  { name: 'living_room.jpg', w: 1920, h: 1280, rgb: [180, 160, 140] },
  { name: 'kitchen.jpg', w: 2200, h: 1467, rgb: [220, 220, 210] },
  { name: 'dining.jpg', w: 1800, h: 1200, rgb: [160, 130, 110] },
  { name: 'primary_bedroom.jpg', w: 2000, h: 1500, rgb: [190, 190, 200] },
  { name: 'bedroom_2.jpg', w: 1600, h: 1200, rgb: [170, 180, 190] },
  { name: 'bathroom.jpg', w: 1500, h: 2000, rgb: [230, 235, 240] }, // portrait
  { name: 'office.jpg', w: 1920, h: 1080, rgb: [140, 150, 130] },
  { name: 'backyard.jpg', w: 2400, h: 1350, rgb: [110, 170, 120] },
  { name: 'pool.jpg', w: 2048, h: 1365, rgb: [90, 160, 200] },
  // EXIF orientation 6 = rotate 90 CW on display. Stored 1600x1000; a correct
  // pipeline should produce a 1000x1600 upright image.
  { name: 'rotated_exif.jpg', w: 1600, h: 1000, rgb: [210, 120, 120], orientation: 6 },
];

for (const s of specs) {
  let img = sharp({
    create: {
      width: s.w,
      height: s.h,
      channels: 3,
      background: { r: s.rgb[0], g: s.rgb[1], b: s.rgb[2] },
    },
  }).jpeg({ quality: 88 });
  if (s.orientation) img = img.withMetadata({ orientation: s.orientation });
  await img.toFile(join(outDir, s.name));
}
console.log(`Wrote ${specs.length} test photos to ${outDir}`);

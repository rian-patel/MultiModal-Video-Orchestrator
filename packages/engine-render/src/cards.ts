import sharp from 'sharp';
import type { Branding } from '@rev/core';

/**
 * Branded title/end cards, rendered as PNGs (SVG text via sharp) and fed to
 * the ffmpeg xfade chain as looped image inputs. Design: dark slate canvas,
 * serif headline, letterspaced kicker — deliberately neutral so it works for
 * any listing without a designer.
 */

const BG = '#0c1220';
const INK = '#f4f7fb';
const MUTED = '#8fa3bf';
const RULE = '#3b4d66';

/** How long each card holds on screen (before crossfade overlap). */
export const CARD_SEC = 3;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

const SERIF = `Georgia, 'Times New Roman', serif`;
const SANS = `'Segoe UI', Arial, sans-serif`;

function svgToPng(svg: string): Promise<Buffer> {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Title card: "PROPERTY TOUR" kicker + address headline (+ "Presented by").
 * Returns null when there is nothing to say (no address and no agent).
 */
export async function renderTitleCard(
  branding: Branding,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const address = branding.address?.trim();
  const agent = branding.agentName?.trim();
  if (!address && !agent) return null;

  const headline = address ?? `Presented by ${agent}`;
  // Long addresses shrink instead of overflowing the frame.
  const size = Math.round(height * (headline.length > 30 ? 0.058 : 0.078));
  const cy = height / 2;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${BG}"/>
  <text x="50%" y="${cy - height * 0.105}" text-anchor="middle" font-family="${SERIF}" font-size="${Math.round(height * 0.031)}" letter-spacing="${Math.round(width * 0.0073)}" fill="${MUTED}">PROPERTY TOUR</text>
  <text x="50%" y="${cy + height * 0.02}" text-anchor="middle" font-family="${SERIF}" font-size="${size}" fill="${INK}">${esc(headline)}</text>
  <line x1="${width * 0.396}" y1="${cy + height * 0.093}" x2="${width * 0.604}" y2="${cy + height * 0.093}" stroke="${RULE}" stroke-width="2"/>
  ${
    address && agent
      ? `<text x="50%" y="${cy + height * 0.167}" text-anchor="middle" font-family="${SANS}" font-size="${Math.round(height * 0.028)}" fill="${MUTED}">Presented by ${esc(agent)}</text>`
      : ''
  }
</svg>`;
  return svgToPng(svg);
}

/**
 * End card: logo (when given) above the agent name and a phone · email line.
 * Returns null when there is no agent/contact/logo content at all.
 */
export async function renderEndCard(
  branding: Branding,
  width: number,
  height: number,
): Promise<Buffer | null> {
  const agent = branding.agentName?.trim();
  const contact = [branding.phone?.trim(), branding.email?.trim()].filter(Boolean).join('   ·   ');
  if (!agent && !contact && !branding.logoPath) return null;

  const cy = height / 2;
  const hasLogo = Boolean(branding.logoPath);
  // With a logo the text block shifts down to make room above.
  const nameY = cy + (hasLogo ? height * 0.083 : -height * 0.019);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${BG}"/>
  ${agent ? `<text x="50%" y="${nameY}" text-anchor="middle" font-family="${SERIF}" font-size="${Math.round(height * 0.056)}" fill="${INK}">${esc(agent)}</text>` : ''}
  ${contact ? `<text x="50%" y="${nameY + height * 0.083}" text-anchor="middle" font-family="${SANS}" font-size="${Math.round(height * 0.028)}" fill="${MUTED}">${esc(contact)}</text>` : ''}
</svg>`;
  const base = await svgToPng(svg);
  if (!hasLogo) return base;

  // Composite the logo centered above the text block.
  const maxLogoH = Math.round(height * 0.19);
  const logo = await sharp(branding.logoPath)
    .resize({ height: maxLogoH, width: Math.round(width * 0.31), fit: 'inside' })
    .png()
    .toBuffer();
  const meta = await sharp(logo).metadata();
  return sharp(base)
    .composite([
      {
        input: logo,
        left: Math.round((width - (meta.width ?? maxLogoH)) / 2),
        top: Math.round(cy - height * 0.065 - (meta.height ?? maxLogoH)),
      },
    ])
    .png()
    .toBuffer();
}

/**
 * Corner watermark: the logo resized for overlay. Opacity is applied in the
 * ffmpeg graph (colorchannelmixer), not here.
 */
export async function renderWatermark(logoPath: string, frameWidth: number): Promise<Buffer> {
  return sharp(logoPath)
    .resize({ width: Math.round(frameWidth * 0.083), fit: 'inside' })
    .png()
    .toBuffer();
}

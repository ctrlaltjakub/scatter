import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { CustomNodeFont } from '@/lib/customNodeFonts';

// Use a real bundled font: export/sync assertions must compare actual bytes,
// not merely a font name that would work only on the originating device.
export const fontBytes = readFileSync('public/fonts/caveat-latin-400-normal.woff2');
export const customFontFixture: CustomNodeFont = {
  id: `custom-font-${createHash('sha256').update(fontBytes).digest('hex')}`,
  name: 'My Caveat', fileName: 'My-Caveat.woff2', format: 'woff2',
  data: fontBytes.toString('base64'), byteLength: fontBytes.length,
};

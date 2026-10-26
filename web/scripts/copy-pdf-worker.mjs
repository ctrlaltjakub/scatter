import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL(
  '../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url,
));
const target = fileURLToPath(new URL('../public/pdf.worker.min.mjs', import.meta.url));

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);

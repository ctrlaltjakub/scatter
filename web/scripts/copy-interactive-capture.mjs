import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loaded as text by the host and injected into the opaque verification frame.
// No CDN, remote capture service, or same-origin sandbox permission is needed.
const target = fileURLToPath(new URL('../public/vendor/html-to-image-1.11.13.js', import.meta.url));
await mkdir(dirname(target), { recursive: true });
await copyFile(new URL('../node_modules/html-to-image/dist/html-to-image.js', import.meta.url), target);
await copyFile(new URL('../node_modules/html-to-image/LICENSE', import.meta.url), `${target}.LICENSE`);

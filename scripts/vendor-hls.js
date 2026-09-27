#!/usr/bin/env node
/**
 * Descarga el build de navegador de hls.js a public/vendor/ para que el
 * reproductor funcione sin CDN. Ejecuta `npm run vendor:hls` para actualizarlo.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.HLS_VERSION ?? '1.5.17';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dest = join(root, 'public', 'vendor', 'hls.min.js');
const sources = [
  `https://cdn.jsdelivr.net/npm/hls.js@${VERSION}/dist/hls.min.js`,
  `https://unpkg.com/hls.js@${VERSION}/dist/hls.min.js`,
];

if (existsSync(dest) && !process.argv.includes('--force')) {
  console.log('public/vendor/hls.min.js ya existe. Usa --force para reemplazarlo.');
  process.exit(0);
}

for (const url of sources) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const code = await response.text();
    if (!code.includes('Hls')) throw new Error('respuesta inesperada');
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, code, 'utf8');
    console.log(`hls.js v${VERSION} guardado en public/vendor/hls.min.js (${code.length} bytes)`);
    process.exit(0);
  } catch (err) {
    console.error(`${url} → ${err.message}`);
  }
}

console.error('No se pudo descargar hls.js. El reproductor usará HLS nativo si el navegador lo soporta.');
process.exit(1);

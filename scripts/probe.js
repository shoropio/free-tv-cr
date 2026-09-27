#!/usr/bin/env node
/**
 * CLI: comprueba qué canales de la lista responden realmente.
 *
 *   node scripts/probe.js            # todos
 *   node scripts/probe.js --deep     # incluye la descarga del primer segmento
 *   node scripts/probe.js --json     # salida JSON
 */
import { loadConfig, ensureDirs } from '../server/config.js';
import { log } from '../server/log.js';
import { Playlist } from '../server/playlist.js';
import { HostGuard } from '../server/http-client.js';
import { checkChannel, mapLimit } from '../server/proxy.js';

loadConfig();
ensureDirs();

const args = new Set(process.argv.slice(2));
const deep = args.has('--deep') || !args.has('--shallow');
const asJson = args.has('--json');

const playlist = new Playlist();
const guard = new HostGuard();
guard.loadConfigured();
await playlist.load();
guard.addHosts(playlist.streamHosts());

const results = await mapLimit(playlist.channels, 6, async (channel) => {
  const result = await checkChannel(channel.url, { guard, timeoutMs: 12000, deep });
  if (!asJson) {
    const mark = result.ok ? '\x1b[32mOK  \x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const extra = result.reason ? ` — ${result.reason}` : ` (${result.latencyMs} ms)`;
    process.stdout.write(`${mark} ${channel.number.toString().padStart(3)}. ${channel.name}${extra}\n`);
  }
  return { id: channel.id, name: channel.name, ...result };
});

if (asJson) {
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
} else {
  const ok = results.filter((r) => r.ok).length;
  log.info(`${ok}/${results.length} canales disponibles`);
  const dead = results.filter((r) => !r.ok).map((r) => r.name);
  if (dead.length) log.info(`Sin señal: ${dead.join(', ')}`);
}

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig, PATHS } from './config.js';
import { log } from './log.js';
import { fetchFollow, readTextCapped, hostOf } from './http-client.js';
import { parseM3U, playlistFingerprint, categoryLabel } from './m3u.js';

const cacheFile = () => join(PATHS.data, 'playlist.json');

/**
 * Loads the iptv-org playlist for Costa Rica.
 * Caches the parsed result on disk so restarts are instant and the app keeps
 * working if GitHub Pages is briefly unreachable.
 */
export class Playlist {
  constructor() {
    this.channels = [];
    this.loadedAt = 0;
    this.fromCache = false;
  }

  get groups() {
    const counts = new Map();
    for (const channel of this.channels) {
      for (const group of channel.groups) counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, label: categoryLabel(name), count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'es'));
  }

  async load({ force = false } = {}) {
    const { playlist } = getConfig();
    const maxAge = force ? 0 : playlist.cacheMinutes * 60_000;

    if (!force && this.channels.length && Date.now() - this.loadedAt < maxAge) {
      return this.channels;
    }
    const cached = this.#readCache(maxAge);
    if (cached) return cached;

    try {
      log.info(`Descargando lista de reproducción: ${playlist.url}`);
      const { response } = await fetchFollow(playlist.url, { timeoutMs: 20000 });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await readTextCapped(response, 16 * 1024 * 1024);
      if (!text.includes('#EXTM3U')) throw new Error('la respuesta no es una lista M3U válida');
      this.channels = parseM3U(text);
      this.loadedAt = Date.now();
      this.fromCache = false;
      this.#writeCache(text);
      log.info(`Lista cargada: ${this.channels.length} canales`);
      return this.channels;
    } catch (err) {
      log.error(`No se pudo actualizar la lista: ${err.message}`);
      const stale = this.#readCache(Infinity);
      if (stale) {
        log.warn('Se usa la copia en caché de la lista.');
        return stale;
      }
      throw err;
    }
  }

  #readCache(maxAge) {
    const file = cacheFile();
    if (!existsSync(file)) return null;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      if (maxAge !== Infinity && Date.now() - data.loadedAt > maxAge) return null;
      this.channels = data.channels;
      this.loadedAt = data.loadedAt;
      this.fromCache = true;
      return this.channels;
    } catch (err) {
      log.warn(`Caché de lista ilegible: ${err.message}`);
      return null;
    }
  }

  #writeCache(text) {
    try {
      mkdirSync(PATHS.data, { recursive: true });
      writeFileSync(
        cacheFile(),
        JSON.stringify({ url: getConfig().playlist.url, loadedAt: this.loadedAt, fingerprint: playlistFingerprint(text), channels: this.channels }, null, 2),
        'utf8',
      );
    } catch (err) {
      log.warn(`No se pudo guardar la caché de la lista: ${err.message}`);
    }
  }

  /** Every host referenced by the playlist, used to seed the proxy allowlist. */
  streamHosts() {
    const hosts = new Set();
    for (const channel of this.channels) {
      const host = hostOf(channel.url);
      if (host) hosts.add(host);
    }
    return [...hosts];
  }
}

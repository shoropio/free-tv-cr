import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PATHS = {
  root: ROOT,
  public: join(ROOT, 'public'),
  data: join(ROOT, 'data'),
  epgCache: join(ROOT, 'data', 'epg'),
  configFile: join(ROOT, 'config.json'),
};

const DEFAULTS = {
  server: { port: 8080, host: '0.0.0.0' },
  playlist: {
    url: 'https://iptv-org.github.io/iptv/countries/cr.m3u',
    cacheMinutes: 180,
  },
  epg: {
    sources: [
      { name: 'iptv-epg.org (Costa Rica)', url: 'https://iptv-epg.org/files/epg-cr.xml.gz' },
    ],
    cacheHours: 6,
    fuzzyMatch: true,
    minFuzzyScore: 0.75,
  },
  proxy: {
    timeoutMs: 15000,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    // "public": any public host, but private/reserved IPs are refused.
    // "playlist": only hosts found in the playlist (plus approved extras).
    policy: 'public',
    allowAnyHost: false,
    extraAllowedHosts: [],
  },
  probe: { timeoutMs: 9000, concurrency: 6, cacheMinutes: 10, deep: true },
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Hosts that are always reachable through the proxy: playlist source + the app's own EPG/asset hosts. */
const BUILTIN_HOSTS = ['iptv-org.github.io', 'iptv-epg.org', 'raw.githubusercontent.com', 'github.com'];

let config = deepMerge(DEFAULTS, {});

export function loadConfig() {
  if (!existsSync(PATHS.configFile)) {
    log.warn(`No se encontró ${PATHS.configFile}; se usan los valores por defecto.`);
    config = deepMerge(DEFAULTS, {});
  } else {
    try {
      config = deepMerge(DEFAULTS, JSON.parse(readFileSync(PATHS.configFile, 'utf8')));
    } catch (err) {
      log.error(`config.json inválido (${err.message}); se usan los valores por defecto.`);
      config = deepMerge(DEFAULTS, {});
    }
  }
  if (process.env.PORT) config.server.port = Number(process.env.PORT);
  if (process.env.HOST) config.server.host = process.env.HOST;
  return config;
}

export function getConfig() {
  return config;
}

/** Persist a runtime addition (currently only approved proxy hosts) back to config.json. */
export function saveConfigPatch(patch) {
  config = deepMerge(config, patch);
  try {
    mkdirSync(dirname(PATHS.configFile), { recursive: true });
    writeFileSync(PATHS.configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } catch (err) {
    log.warn(`No se pudo guardar config.json: ${err.message}`);
  }
  return config;
}

export function ensureDirs() {
  mkdirSync(PATHS.data, { recursive: true });
  mkdirSync(PATHS.epgCache, { recursive: true });
}

export { BUILTIN_HOSTS };

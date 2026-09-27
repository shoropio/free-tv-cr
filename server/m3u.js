import { createHash } from 'node:crypto';

const ATTR_RE = /([A-Za-z0-9_-]+)=("(?:[^"\\]|\\.)*"|[^\s,]*)/g;

/** Extracts `key="value"` pairs from an #EXTINF attribute string. */
export function parseAttributes(input) {
  const attrs = {};
  if (!input) return attrs;
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(input)) !== null) {
    let value = match[2] ?? '';
    if (value.startsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    attrs[match[1].toLowerCase()] = value;
  }
  return attrs;
}

/**
 * Splits `#EXTINF:<duration> <attrs>,<title>` honouring quoted commas.
 * @returns {{duration: string, attrs: string, title: string}}
 */
export function splitExtinf(line) {
  const body = line.slice('#EXTINF:'.length);
  let inQuotes = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) {
      const head = body.slice(0, i);
      const sp = head.search(/\s/);
      return {
        duration: sp === -1 ? head.trim() : head.slice(0, sp),
        attrs: sp === -1 ? '' : head.slice(sp + 1),
        title: body.slice(i + 1).trim(),
      };
    }
  }
  return { duration: body.trim(), attrs: '', title: '' };
}

const FLAG_RE = /\s*\[(Not 24\/7|Geo-blocked)\]/gi;
const RES_RE = /\((\d{3,4}p)\)/i;

/**
 * iptv-org etiqueta los canales con categorías en inglés; la interfaz está en
 * español, así que se traducen aquí. Cualquier categoría desconocida se muestra
 * tal cual llega.
 */
const CATEGORY_LABELS = new Map(
  Object.entries({
    general: 'General',
    music: 'Música',
    religious: 'Religioso',
    entertainment: 'Entretenimiento',
    sports: 'Deportes',
    sport: 'Deportes',
    animation: 'Animación',
    classic: 'Clásicos',
    culture: 'Cultura',
    kids: 'Infantil',
    news: 'Noticias',
    travel: 'Viajes',
    documentary: 'Documentales',
    education: 'Educación',
    family: 'Familiar',
    comedy: 'Comedia',
    cooking: 'Cocina',
    business: 'Negocios',
    lifestyle: 'Estilo de vida',
    outdoor: 'Aire libre',
    weather: 'Clima',
    local: 'Local',
    regional: 'Regional',
    legislative: 'Legislativo',
    senate: 'Senado',
  }),
);

/** Traduce una categoría de iptv-org; devuelve la original si no está en el mapa. */
export function categoryLabel(name) {
  return CATEGORY_LABELS.get(String(name).trim().toLowerCase()) ?? name;
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Parses an M3U/M3U8 playlist into normalised channel objects.
 * @param {string} text raw playlist body
 * @returns {Array<object>} channels
 */
export function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const channels = [];
  const usedSlugs = new Map();
  let pending = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const { duration, attrs, title } = splitExtinf(line);
      const a = parseAttributes(attrs);
      const flags = [];
      FLAG_RE.lastIndex = 0;
      let flagMatch;
      while ((flagMatch = FLAG_RE.exec(title)) !== null) flags.push(flagMatch[1].toLowerCase());
      const cleanTitle = title.replace(FLAG_RE, '').trim() || a['tvg-name'] || 'Canal sin nombre';

      const tvgId = (a['tvg-id'] || '').trim();
      const qualityTag = (tvgId.match(/@(HD|SD|HEVC|FHD|UHD)$/i)?.[1] || '').toUpperCase();
      const baseId = tvgId.split('@')[0].trim();

      const groups = (a['group-title'] || '')
        .split(/[;,]/)
        .map((g) => g.trim())
        .filter((g) => g && g.toLowerCase() !== 'undefined');

      pending = {
        tvgId: baseId,
        qualityTag: qualityTag || (/fhd|1080|uhd/i.test(a['tvg-name'] ?? '') ? 'HD' : ''),
        name: cleanTitle,
        logo: (a['tvg-logo'] || '').trim(),
        groups: groups.length ? groups : ['General'],
        duration: Number(duration) || -1,
        is24x7: !flags.includes('not 24/7'),
        geoBlocked: flags.includes('geo-blocked'),
        resolution: (cleanTitle.match(RES_RE)?.[1] || '').toLowerCase(),
        language: (a['tvg-language'] || '').trim(),
        url: '',
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      const channel = { ...pending, url: line };
      let slug = slugify(baseIdOf(channel)) || slugify(channel.name);
      if (!slug) slug = `canal-${channels.length + 1}`;
      const seen = usedSlugs.get(slug) ?? 0;
      usedSlugs.set(slug, seen + 1);
      if (seen > 0) slug = `${slug}-${seen + 1}`;
      channel.id = slug;
      channel.number = channels.length + 1;
      channels.push(channel);
      pending = null;
    }
  }

  return channels;
}

const baseIdOf = (channel) => channel.tvgId || `${channel.name}-${channel.number ?? ''}`;

/** Stable fingerprint of a playlist, used to invalidate caches. */
export const playlistFingerprint = (text) =>
  createHash('sha1').update(text).digest('hex').slice(0, 12);

#!/usr/bin/env node
/**
 * Unit tests for the pure logic: M3U parsing, HLS manifest rewriting, XMLTV
 * parsing/time handling and channel matching.
 *
 *   node --test scripts/test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseM3U, splitExtinf, parseAttributes, categoryLabel } from '../server/m3u.js';
import { rewriteManifest, decodeTarget, looksLikeManifest, checkChannel, mapLimit } from '../server/proxy.js';
import { parseXmltv, parseXmltvTime, similarity, normalizeId } from '../server/epg.js';
import { HostGuard, isPublicAddress } from '../server/http-client.js';
import { getConfig } from '../server/config.js';

const decode = (rewritten) => decodeTarget(rewritten.split('u=')[1]);

/* ------------------------------------------------------------------ *
 * M3U
 * ------------------------------------------------------------------ */

test('splitExtinf respects commas inside quotes', () => {
  const { duration, attrs, title } = splitExtinf('#EXTINF:-1 tvg-id="A.cr" group-title="News;Sport",Canal A, the Second');
  assert.equal(duration, '-1');
  assert.equal(attrs, 'tvg-id="A.cr" group-title="News;Sport"');
  assert.equal(title, 'Canal A, the Second');
});

test('parseAttributes handles quoted and bare values', () => {
  const attrs = parseAttributes('tvg-id="A.cr" tvg-logo="http://x/y.png" group-title=General width=640');
  assert.equal(attrs['tvg-id'], 'A.cr');
  assert.equal(attrs['tvg-logo'], 'http://x/y.png');
  assert.equal(attrs['group-title'], 'General');
});

test('parseM3U extracts flags, groups, quality and ids', () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="Teletica7.cr@HD" tvg-logo="http://l/a.png" group-title="General",Teletica 7 (1080p) [Not 24/7]',
    'https://h1/a/playlist.m3u8',
    '#EXTINF:-1 tvg-id="X.cr@SD" group-title="Undefined",Canal X (576p) [Geo-blocked]',
    'https://h2/b.m3u8',
  ].join('\r\n');

  const channels = parseM3U(m3u);
  assert.equal(channels.length, 2);

  const [a, b] = channels;
  assert.equal(a.tvgId, 'Teletica7.cr');
  assert.equal(a.qualityTag, 'HD');
  assert.equal(a.is24x7, false);
  assert.equal(a.geoBlocked, false);
  assert.equal(a.resolution, '1080p');
  assert.equal(a.name, 'Teletica 7 (1080p)');
  assert.equal(a.url, 'https://h1/a/playlist.m3u8');
  assert.equal(a.id, 'teletica7-cr');

  assert.equal(b.geoBlocked, true);
  assert.deepEqual(b.groups, ['General'], 'group-title "Undefined" must fall back to General');
});

test('parseM3U tolerates entries without tvg-id and keeps ids unique', () => {
  const m3u = ['#EXTM3U', '#EXTINF:-1,Canal Sin Id', 'http://h/a.m3u8', '#EXTINF:-1,Canal Sin Id', 'http://h/b.m3u8'].join('\n');
  const channels = parseM3U(m3u);
  assert.equal(channels.length, 2);
  assert.notEqual(channels[0].id, channels[1].id);
});

test('categoryLabel translates iptv-org categories and keeps unknown ones', () => {
  assert.equal(categoryLabel('Sports'), 'Deportes');
  assert.equal(categoryLabel('music'), 'Música');
  assert.equal(categoryLabel('  Religious  '), 'Religioso');
  assert.equal(categoryLabel('General'), 'General');
  // Categorías que no están en el mapa se devuelven tal cual.
  assert.equal(categoryLabel('Canal Local CR'), 'Canal Local CR');
});

/* ------------------------------------------------------------------ *
 * Manifest rewriting
 * ------------------------------------------------------------------ */

test('rewriteManifest rewrites segment and variant URIs to proxy paths', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
    'high/index.m3u8',
  ].join('\n');

  const out = rewriteManifest(manifest, 'https://cdn.example.com/live/master.m3u8');
  const uris = out.split('\n').filter((l) => l.trim() && !l.startsWith('#'));

  assert.equal(uris.length, 2);
  for (const uri of uris) {
    assert.match(uri, /^\/hls\?u=/, 'every URI must be an absolute proxy path');
  }
  assert.equal(decode(uris[0]), 'https://cdn.example.com/live/low/index.m3u8');
  assert.equal(decode(uris[1]), 'https://cdn.example.com/live/high/index.m3u8');
});

test('rewriteManifest resolves URI="" attributes of keys, maps and renditions', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="../key.bin",IV=0x00',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/es.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframe.m3u8"',
    '#EXTINF:4.0,',
    'seg1.ts',
  ].join('\n');

  const out = rewriteManifest(manifest, 'https://cdn.example.com/hls/v1/index.m3u8');
  const uriOf = (pattern) => decode(new RegExp(pattern).exec(out)[1]);

  assert.equal(uriOf('#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"'), 'https://cdn.example.com/hls/key.bin');
  assert.equal(uriOf('#EXT-X-MAP:URI="([^"]+)"'), 'https://cdn.example.com/hls/v1/init.mp4');
  assert.equal(uriOf('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="([^"]+)"'), 'https://cdn.example.com/hls/v1/audio/es.m3u8');
  assert.equal(uriOf('#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="([^"]+)"'), 'https://cdn.example.com/hls/v1/iframe.m3u8');

  const segment = out.split('\n').find((line) => line.trim() && !line.startsWith('#'));
  assert.match(segment, /^\/hls\?u=/);
  assert.equal(decode(segment), 'https://cdn.example.com/hls/v1/seg1.ts');
});

test('rewriteManifest preserves absolute URIs and non-EXT-X comments', () => {
  const manifest = ['#EXTM3U', '# a plain comment', 'https://other.example/seg.ts'].join('\n');
  const out = rewriteManifest(manifest, 'https://cdn.example.com/a/index.m3u8');
  assert.match(out, /# a plain comment/);
  assert.equal(decode(out.split('\n')[2]), 'https://other.example/seg.ts');
});

test('decodeTarget rejects non-http payloads', () => {
  assert.equal(decodeTarget(Buffer.from('file:///etc/passwd').toString('base64url')), null);
  assert.equal(decodeTarget(Buffer.from('/etc/passwd').toString('base64url')), null);
  assert.equal(decodeTarget(''), null);
  assert.equal(decodeTarget(undefined), null);
  assert.equal(decodeTarget(Buffer.from('https://ok.example/a.m3u8').toString('base64url')), 'https://ok.example/a.m3u8');
});

test('looksLikeManifest detects playlists by URL and MIME type', () => {
  assert.ok(looksLikeManifest('https://x/a.m3u8', 'application/octet-stream'));
  assert.ok(looksLikeManifest('https://x/a', 'application/vnd.apple.mpegurl'));
  assert.ok(looksLikeManifest('https://x/live.m3u8?token=1', ''));
  assert.ok(!looksLikeManifest('https://x/seg.ts', 'video/mp2t'));
  assert.ok(!looksLikeManifest('https://x/seg.ts', '', '<html>'));
});

/* ------------------------------------------------------------------ *
 * XMLTV
 * ------------------------------------------------------------------ */

test('parseXmltvTime handles offsets, missing seconds and bare values', () => {
  const iso = (ms) => new Date(ms).toISOString();
  assert.equal(iso(parseXmltvTime('20260926013500 +0000')), '2026-09-26T01:35:00.000Z');
  assert.equal(iso(parseXmltvTime('20260926013500 -0600')), '2026-09-26T07:35:00.000Z');
  assert.equal(iso(parseXmltvTime('202609260135 +0000')), '2026-09-26T01:35:00.000Z');
  assert.equal(parseXmltvTime(''), null);
  assert.equal(parseXmltvTime('nonsense'), null);
});

test('parseXmltv reads display-name elements and drops No Data placeholders', () => {
  const xml = [
    '<tv>',
    '<channel id="Canal4.cr"><display-name>CR - Canal 4</display-name><icon src="http://x/i.png"/></channel>',
    '<channel id="TigoSport.cr"><display-name>CR - Tigo Sport</display-name></channel>',
    '<programme start="20260926013500 +0000" stop="20260926023000 +0000" channel="Canal4.cr">',
    '<title lang="es">Noticias &amp; más</title><desc>Resumen</desc></programme>',
    '<programme start="20260926013500 +0000" stop="20260926023000 +0000" channel="TigoSport.cr">',
    '<title>No Data</title><desc>https://example/help</desc></programme>',
    '</tv>',
  ].join('\n');

  const { channels, programmes } = parseXmltv(xml);
  assert.equal(channels.get('Canal4.cr').name, 'CR - Canal 4');
  assert.equal(channels.get('Canal4.cr').icon, 'http://x/i.png');
  assert.equal(programmes.get('Canal4.cr').length, 1);
  assert.equal(programmes.get('Canal4.cr')[0].title, 'Noticias & más');
  assert.equal(programmes.has('TigoSport.cr'), false, 'No Data placeholders must be discarded');
});

/* ------------------------------------------------------------------ *
 * Matching
 * ------------------------------------------------------------------ */

test('normalizeId strips country, quality tag, parentheticals and stop words', () => {
  assert.equal(normalizeId('Canal 1 (Costa Rica)'), 'canal1');
  assert.equal(normalizeId('CR - Canal 1'), 'canal1');
  assert.equal(normalizeId('Canal1.cr@HD'), 'canal1');
  assert.equal(normalizeId('Tigo Sports (Costa Rica) (720p)'), 'tigosports');
});

test('similarity separates channel numbers but allows spelling variants', () => {
  assert.equal(similarity('Canal 1 (Costa Rica)', 'CR - Canal 1'), 1);
  assert.equal(similarity('Tigo Sports (Costa Rica)', 'TigoSport.cr'), 0.9);
  // A different channel number must never be considered a match.
  assert.ok(similarity('Canal 1 (Costa Rica)', 'Canal11.cr') < 0.75, 'Canal 1 must not match Canal 11');
  assert.ok(similarity('Canal 1 (Costa Rica)', 'Canal 4 (Costa Rica)') < 0.75);
  // A qualifier changes the channel identity, not just its spelling.
  assert.ok(similarity('Enlace Juvenil', 'Enlace.cr') < 0.75, 'Enlace Juvenil is not Enlace');
});

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

test('mapLimit preserves order and bounds concurrency', async () => {
  let active = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = await mapLimit(items, 3, async (n) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    return n * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16]);
  assert.ok(peak <= 3, `peak concurrency ${peak} exceeded the limit`);
});

test('checkChannel surfaces a clear reason for a dead stream', async () => {
  const guard = { check: () => ({ ok: true }) };
  const result = await checkChannel('https://127.0.0.1:1/nope.m3u8', { guard, timeoutMs: 1500, deep: false });
  assert.equal(result.ok, false);
  assert.ok(result.reason, 'a failure must carry a human-readable reason');
});

/* ------------------------------------------------------------------ *
 * SSRF protection
 * ------------------------------------------------------------------ */

test('isPublicAddress rejects private, loopback and reserved ranges', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '198.18.0.1', '224.0.0.1',
    '240.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1',
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} must be treated as private`);
  }

  const allowed = ['8.8.8.8', '1.1.1.1', '190.61.90.17', '172.32.0.1', '172.15.255.255', '2606:4700::1111'];
  for (const ip of allowed) {
    assert.equal(isPublicAddress(ip), true, `${ip} must be treated as public`);
  }
});

test('HostGuard refuses private targets and accepts public ones', async () => {
  const guard = new HostGuard();

  assert.equal((await guard.check('http://127.0.0.1:8080/admin')).ok, false);
  assert.equal((await guard.check('http://169.254.169.254/latest/meta-data/')).ok, false);
  assert.equal((await guard.check('http://[::1]:8080/')).ok, false);
  assert.equal((await guard.check('file:///etc/passwd')).ok, false);

  assert.equal((await guard.check('https://iptv-org.github.io/iptv/countries/cr.m3u')).ok, true);
  assert.equal((await guard.check('https://1.1.1.1/x.m3u8')).ok, true);
});

test('HostGuard in playlist mode blocks hosts outside the list until approved', async () => {
  const previous = getConfig().proxy.policy;
  getConfig().proxy.policy = 'playlist';
  try {
    const guard = new HostGuard();
    guard.addHost('stream.example.com');

    assert.equal((await guard.check('https://stream.example.com/a.m3u8')).ok, true);
    const blocked = await guard.check('https://other-cdn.example.org/a.m3u8');
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /no permitido/);

    guard.approveHost('other-cdn.example.org', { persist: false });
    assert.equal((await guard.check('https://other-cdn.example.org/a.m3u8')).ok, true);
  } finally {
    getConfig().proxy.policy = previous;
  }
});

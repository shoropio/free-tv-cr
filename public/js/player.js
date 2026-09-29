import { api } from './api.js';
import { store } from './store.js';
import {
  $, el, fmtRange, fmtTime, fmtBitrate, fold, initials, isCurrent, isPast,
  relativeLabel, restoreFocus, setBackgroundInert, toast,
} from './util.js';

const HLS_ATTACH_TIMEOUT = 12000;

/**
 * Owns the <video> element, the hls.js instance and the side panel
 * (channel list + EPG timeline + quality picker).
 */
export class Player {
  constructor({ onClose, onChange, getChannels }) {
    this.onClose = onClose;
    this.onChange = onChange;
    this.getChannels = getChannels;

    this.hls = null;
    this.channel = null;
    this.levels = [];
    this.programmes = [];
    this.statsTimer = null;
    this.epgTimer = null;
    this.attachTimer = null;
    this.retryTimer = null;
    this.pendingHost = null;
    this.netRetries = 0;
    this.returnFocus = null;

    this.video = $('#video');
    this.root = $('#player');
    this.shell = $('.player__shell');
    this.overlay = $('#player-overlay');
    this.statusEl = $('#player-status');
    this.statEl = $('#player-stat');
    this.qualityWrap = $('#quality-wrap');
    this.qualitySelect = $('#quality-select');
    this.listEl = $('#player-list');
    this.gridEl = $('#player-grid');
    this.epgNow = $('#epg-now');
    this.epgTimeline = $('#epg-timeline');
    this.timelineTitle = $('#epg-timeline-title');

    this.#wireControls();
  }

  /* ============================== Public API ============================== */

  get isOpen() {
    return !this.root.hidden;
  }

  async open(channel) {
    this.returnFocus = document.activeElement;
    this.root.hidden = false;
    this.root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    setBackgroundInert(true);
    // Búsqueda limpia: input, lista lateral y rejilla empiezan sincronizados.
    $('#player-search').value = '';
    this.#renderList('');
    this.#renderGrid('');
    $('#btn-sidebar').classList.remove('is-open');
    this.listEl.classList.remove('is-open');
    this.shell.focus({ preventScroll: true });
    await this.load(channel);
  }

  close() {
    this.#teardown();
    this.root.hidden = true;
    this.root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    setBackgroundInert(false);
    restoreFocus(this.returnFocus, $('#channel-grid'));
    this.returnFocus = null;
    this.onClose?.();
  }

  /** Loads a channel into the existing player (used for next/prev and rail clicks). */
  async load(channel) {
    this.channel = channel;
    this.netRetries = 0;
    // Cada carga arranca sin distintivo EN VIVO: lo enciende el evento `play`.
    this.#setLive(false);

    $('#player-channel-name').textContent = channel.name;
    const meta = [(channel.groupLabels ?? channel.groups).join(', '), channel.is24x7 ? '24/7' : 'No 24/7', channel.upstreamHost]
      .filter(Boolean)
      .join(' · ');
    $('#player-channel-meta').textContent = meta;

    const logo = $('#player-logo');
    logo.src = channel.logo ? `/img?u=${encodeURIComponent(channel.logo)}` : '';
    logo.alt = '';
    logo.style.visibility = channel.logo ? 'visible' : 'hidden';

    this.#syncFavoriteButton();
    this.#markCurrent();
    this.#loadEpg(channel);
    await this.#attach(channel);
  }

  /** Steps to the next/previous channel in the currently filtered list. */
  step(delta) {
    const list = this.visibleChannels();
    if (!list.length) return;
    const index = list.findIndex((c) => c.id === this.channel?.id);
    const next = list[(index + delta + list.length) % list.length];
    if (next) this.load(next);
  }

  /** Channels matching a free-text query (name or category), shared by every view. */
  #matching(query) {
    const q = fold(query);
    const list = this.getChannels();
    if (!q) return list;
    return list.filter(
      (channel) =>
        fold(channel.name).includes(q) ||
        fold((channel.groupLabels ?? channel.groups).join(' ')).includes(q),
    );
  }

  visibleChannels() {
    return this.#matching($('#player-search').value);
  }

  /* ============================== HLS ============================== */

  async #attach(channel) {
    this.#teardownStream();
    this.#setStatus('Conectando…', true);
    this.statEl.textContent = '';
    this.#setQualityOptions([]);

    const Hls = window.Hls;
    const canNative = this.video.canPlayType('application/vnd.apple.mpegurl');

    if (Hls?.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferLength: 24,
        maxMaxBufferLength: 45,
        startFragPrefetch: true,
        manifestLoadingMaxRetry: 3,
        manifestLoadingRetryDelay: 900,
        levelLoadingMaxRetry: 4,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 1200,
        // The proxy already normalises the origin, so keep it simple and let
        // hls.js follow the rewritten relative proxy URLs.
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        },
      });
      this.hls = hls;

      hls.on(window.Hls.Events.MANIFEST_PARSED, (_e, data) => {
        this.levels = data.levels ?? [];
        this.#setQualityOptions(this.levels);
        this.#clearError();
        this.#setStatus('', false);
        hls.startLoad();
        this.video.play().catch(() => {
          // Autoplay may be blocked; the native controls show a play button.
          this.#setStatus('Pulsa ▶ para comenzar la reproducción', false);
        });
      });

      hls.on(window.Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const level = this.levels[data.level];
        if (level) this.statEl.textContent = this.#describeLevel(level, data.level === -1);
      });

      hls.on(window.Hls.Events.ERROR, (_e, data) => this.#onHlsError(data));

      hls.attachMedia(this.video);
      hls.loadSource(channel.url);

      this.attachTimer = setTimeout(() => {
        if (this.channel?.id !== channel.id) return;
        if (!this.video.currentSrc && this.levels.length === 0) {
          this.#setStatus('El canal no responde. Puede estar caído o restringido a tu región.', false);
        }
      }, HLS_ATTACH_TIMEOUT);
      return;
    }

    if (canNative) {
      // Safari / iOS play HLS natively.
      this.video.src = channel.url;
      this.video.addEventListener('loadedmetadata', () => this.#setStatus('', false), { once: true });
      this.video.addEventListener('error', () => this.#setStatus('No se pudo reproducir este canal.', false), {
        once: true,
      });
      this.video.play().catch(() => {});
      this.#setQualityOptions([]);
      return;
    }

    this.#setStatus('Este navegador no puede reproducir HLS. Prueba con Chrome, Edge, Firefox o Safari.', false);
  }

  #onHlsError(data) {
    const Hls = window.Hls;
    if (!data.fatal) return;

    // The proxy answers 403 with a JSON body when a stream redirects to a host
    // outside the playlist. Offer to approve it.
    const response = data.response;
    if (response?.code === 403 && typeof response.text === 'string' && response.text.includes('canApprove')) {
      let payload = null;
      try {
        payload = JSON.parse(response.text);
      } catch {
        /* ignore malformed body */
      }
      if (payload?.host) {
        this.#setStatus(`El servidor de este canal usa un dominio externo (${payload.host}).`, false);
        this.#offerHostApproval(payload.host);
        return;
      }
    }

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        this.netRetries += 1;
        if (this.netRetries > 3) {
          // Sin límite esto daría vueltas contra un stream muerto: se para y se
          // ofrece un reintento manual.
          this.#setStatus('El canal no responde. Puede estar caído o restringido a tu región.', false,
            el('div', { class: 'toast__actions' }, [
              el('button', {
                type: 'button',
                text: 'Reintentar',
                onclick: () => this.channel && this.load(this.channel),
              }),
            ]));
          this.hls?.stopLoad();
          break;
        }
        // startLoad() no siempre reanuda (p. ej. manifiesto 404): se reconecta
        // entero con un margen. El contador solo lo reinician load() y playing.
        this.#setStatus('Error de red. Reintentando…', true);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.channel && this.isOpen) this.#attach(this.channel);
        }, 1200);
        break;
      case Hls.ErrorTypes.MEDIA_ERROR:
        this.#setStatus('Error de medio. Recuperando…', true);
        this.hls?.recoverMediaError();
        break;
      default:
        this.#setStatus(`No se pudo reproducir el canal${data.details ? ` (${data.details})` : ''}.`, false);
        this.hls?.destroy();
        this.hls = null;
    }
  }

  #offerHostApproval(host) {
    this.pendingHost = host;
    this.#setStatus(
      `Este canal redirige a ${host}, un dominio que no está en la lista.`,
      false,
      el('div', { class: 'toast__actions' }, [
        el('button', {
          type: 'button',
          text: 'Permitir dominio',
          onclick: async () => {
            try {
              await api.allowHost(host);
              toast(`Dominio ${host} permitido. Reintentando…`, { type: 'ok' });
              if (this.channel) await this.load(this.channel);
            } catch (err) {
              toast(`No se pudo permitir el dominio: ${err.message}`, { type: 'error' });
            }
          },
        }),
        el('button', { type: 'button', class: 'ghost', text: 'Cancelar', onclick: () => this.#clearError() }),
      ]),
    );
  }

  #teardownStream() {
    clearTimeout(this.attachTimer);
    clearTimeout(this.retryTimer);
    this.attachTimer = null;
    this.retryTimer = null;
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
    this.video.load();
    this.levels = [];
  }

  #teardown() {
    this.#teardownStream();
    clearInterval(this.statsTimer);
    clearInterval(this.epgTimer);
    this.statsTimer = null;
    this.epgTimer = null;
    this.pendingHost = null;
  }

  /* ============================== Quality ============================== */

  #setQualityOptions(levels) {
    this.qualitySelect.replaceChildren();
    if (!levels.length) {
      this.qualityWrap.hidden = true;
      return;
    }
    this.qualityWrap.hidden = false;
    this.qualitySelect.append(el('option', { value: '-1', text: 'Auto (ABR)' }));
    levels
      .map((level, index) => ({ level, index }))
      .sort((a, b) => (b.level.height ?? 0) - (a.level.height ?? 0) || (b.level.bitrate ?? 0) - (a.level.bitrate ?? 0))
      .forEach(({ level, index }) => {
        const label = [
          level.height ? `${level.height}p` : null,
          fmtBitrate(level.bitrate),
        ]
          .filter(Boolean)
          .join(' · ');
        this.qualitySelect.append(el('option', { value: String(index), text: label || `Nivel ${index + 1}` }));
      });
  }

  #describeLevel(level, isAuto) {
    const parts = [
      level.height ? `${level.height}p` : null,
      level.frameRate ? `${Math.round(level.frameRate)} fps` : null,
      fmtBitrate(level.bitrate),
      isAuto ? 'automática' : 'fija',
    ].filter(Boolean);
    return parts.join(' · ');
  }

  #setQuality(value) {
    if (!this.hls) return;
    this.hls.currentLevel = Number(value);
  }

  /* ============================== EPG ============================== */

  async #loadEpg(channel) {
    clearInterval(this.epgTimer);
    this.epgNow.replaceChildren(el('p', { class: 'epg-now__empty', text: 'Buscando programación…' }));
    this.epgTimeline.replaceChildren();

    try {
      const data = await api.epgTimeline(channel.id);
      if (this.channel?.id !== channel.id) return;
      this.#renderEpg(channel, data);
      // Keep "En curso" and the progress bar honest without re-fetching.
      this.epgTimer = setInterval(() => this.#refreshNowState(), 60000);
    } catch {
      if (this.channel?.id !== channel.id) return;
      this.#renderNoEpg();
    }
  }

  #renderEpg(channel, data) {
    if (!data.matched || !data.programmes?.length) {
      this.#renderNoEpg(channel);
      return;
    }

    const now = Date.now();
    const list = data.programmes;
    this.programmes = list;
    const index = list.findIndex((p) => p.start <= now && now < p.stop);
    const current = index >= 0 ? list[index] : list.find((p) => p.start > now) ?? list.at(-1);

    this.timelineTitle.textContent = `Programación · ${data.epgName ?? channel.name}`;
    this.epgNow.replaceChildren(
      el('div', { class: 'epg-now__label', text: current ? relativeLabel(current.start, current.stop, now) : 'Programación' }),
      el('div', { class: 'epg-now__title', text: current?.title || 'Sin título' }),
      el('div', {
        class: 'epg-now__time',
        text: current ? fmtRange(current.start, current.stop) : '',
        dataset: current ? { range: `${current.start}|${current.stop}` } : {},
      }),
      // Barra de avance del programa en curso: mismo dato, solo presentación.
      current
        ? el('div', { class: 'progress', dataset: { start: String(current.start), stop: String(current.stop) } }, [
            el('div', { class: 'progress__bar' }),
          ])
        : null,
      current?.desc ? el('div', { class: 'epg-now__desc', text: current.desc }) : null,
    );
    this.#paintProgress();

    // Rest of today, plus a few hours of tomorrow for late-night viewing.
    const endOfDay = new Date(now).setHours(24, 0, 0, 0);
    const upcoming = list.filter((p) => p.stop > now - 3600_000 && p.start < endOfDay + 6 * 3600_000);

    this.epgTimeline.replaceChildren(
      ...(upcoming.length
        ? upcoming.map((programme) =>
            el('li', { class: isCurrent(programme, now) ? 'is-current' : isPast(programme, now) ? 'is-past' : '' }, [
              el('div', { class: 'epg-timeline__time', text: fmtTime(programme.start) }),
              el('div', { class: 'epg-timeline__body' }, [
                el('div', { class: 'epg-timeline__title', text: programme.title || 'Sin título' }),
                programme.desc ? el('div', { class: 'epg-timeline__desc', text: programme.desc }) : null,
              ]),
            ]),
          )
        : [
            el('li', {}, [
              el('div', { class: 'epg-timeline__body' }, [
                el('div', { class: 'epg-timeline__title', text: 'No hay más programas en la guía.' }),
              ]),
            ]),
          ]),
    );
  }

  /** Avance del programa en curso, derivado de las horas ya cargadas. */
  #paintProgress() {
    const bar = this.epgNow.querySelector('.progress');
    if (!bar) return;
    const start = Number(bar.dataset.start);
    const stop = Number(bar.dataset.stop);
    const span = stop - start;
    if (!span) return;
    const value = Math.min(100, Math.max(0, ((Date.now() - start) / span) * 100));
    bar.querySelector('.progress__bar')?.style.setProperty('--p', `${value.toFixed(1)}%`);
  }

  /** Called every minute so "En curso" and the timeline highlights stay honest. */
  #refreshNowState() {
    const now = Date.now();
    const list = this.programmes ?? [];
    const current = list.find((p) => p.start <= now && now < p.stop);

    const label = this.epgNow.querySelector('.epg-now__label');
    const timeEl = this.epgNow.querySelector('.epg-now__time');
    if (label && current && timeEl?.dataset.range) {
      label.textContent = relativeLabel(current.start, current.stop, now);
      const title = this.epgNow.querySelector('.epg-now__title');
      if (title) title.textContent = current.title || 'Sin título';
      timeEl.textContent = fmtRange(current.start, current.stop);
    }
    this.#paintProgress();

    // Walk the timeline entries in order, painting past/current state.
    const items = [...this.epgTimeline.querySelectorAll('li')];
    const starts = list.filter((p) => p.stop > now - 3600_000);
    items.forEach((item, index) => {
      const programme = starts[index];
      if (!programme) return;
      item.classList.toggle('is-current', isCurrent(programme, now));
      item.classList.toggle('is-past', isPast(programme, now));
    });
  }

  #renderNoEpg(channel) {
    this.programmes = [];
    this.timelineTitle.textContent = 'Programación';
    this.epgNow.replaceChildren(
      el('p', { class: 'epg-now__empty', text: 'Este canal no tiene guía de programación disponible.' }),
    );
    this.epgTimeline.replaceChildren();
  }

  /* ============================== Lists ============================== */

  #renderList(query = '') {
    const list = this.#matching(query);
    this.listEl.replaceChildren(
      ...list.map((channel) =>
        el(
          'button',
          {
            type: 'button',
            class: 'player__list-item',
            dataset: { id: channel.id },
            onclick: () => {
              // Elegir de la lista la cierra: no debe seguir tapando el vídeo.
              this.listEl.classList.remove('is-open');
              this.load(channel);
            },
          },
          [
            channel.logo
              ? el('img', { src: `/img?u=${encodeURIComponent(channel.logo)}`, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer' })
              : el('span', { class: 'epg-line__time', text: initials(channel.name) }),
            el('span', { text: channel.name }),
          ],
        ),
      ),
    );
    this.#markCurrent();
  }

  #renderGrid(query = '') {
    const list = this.#matching(query);

    if (!list.length) {
      this.gridEl.replaceChildren(
        el('p', { class: 'empty-state', role: 'listitem', text: 'Ningún canal coincide con tu búsqueda.' }),
      );
      return;
    }

    this.gridEl.replaceChildren(
      ...list.map((channel) =>
        el('div', { class: 'card', role: 'listitem', dataset: { id: channel.id } }, [
          el('button', { type: 'button', class: 'card__main', onclick: () => this.load(channel) }, [
            el('div', { class: 'card__logo-wrap' }, [
              channel.logo
                ? el('img', {
                    class: 'card__logo',
                    src: `/img?u=${encodeURIComponent(channel.logo)}`,
                    alt: '',
                    loading: 'lazy',
                    referrerPolicy: 'no-referrer',
                  })
                : el('span', { class: 'card__logo-fallback', text: initials(channel.name) }),
            ]),
            el('div', { class: 'card__body' }, [
              el('span', { class: 'card__name', text: channel.name }),
            ]),
          ]),
        ]),
      ),
    );
    this.#markCurrent();
  }

  #markCurrent() {
    const id = this.channel?.id;
    for (const node of this.root.querySelectorAll('[data-id]')) {
      node.classList.toggle('is-current', node.dataset.id === id);
    }
    this.listEl.querySelector('.is-current')?.scrollIntoView({ block: 'nearest' });
  }

  /* ============================== UI wiring ============================== */

  #setStatus(message, loading, extra = null) {
    this.overlay.classList.toggle('is-visible', !!message);
    // Un error apaga el distintivo EN VIVO: el badge no puede mentir.
    if (message && !loading) this.#setLive(false);
    this.statusEl.replaceChildren(
      ...(message ? [message] : []),
      ...(extra ? [extra] : []),
    );
    this.overlay.querySelector('.spinner')?.remove();
    if (loading && !this.overlay.querySelector('.spinner')) {
      this.overlay.prepend(el('div', { class: 'spinner' }));
    }
  }

  #clearError() {
    this.pendingHost = null;
    this.overlay.classList.remove('is-visible');
  }

  /** Distintivo EN VIVO junto al nombre del canal: refleja el estado real. */
  #setLive(on) {
    this.root.classList.toggle('is-live', on);
    const badge = $('#player-live');
    if (badge) badge.hidden = !on;
  }

  #syncFavoriteButton() {
    const button = $('#btn-fav');
    const on = this.channel ? store.isFavorite(this.channel.id) : false;
    button.textContent = on ? '★' : '☆';
    button.classList.toggle('is-on', on);
  }

  #wireControls() {
    $('#btn-close-player').addEventListener('click', () => this.close());
    $('#player-backdrop').addEventListener('click', () => this.close());
    $('#btn-prev').addEventListener('click', () => this.step(-1));
    $('#btn-next').addEventListener('click', () => this.step(1));
    $('#btn-sidebar').addEventListener('click', () => this.listEl.classList.toggle('is-open'));

    $('#btn-play').addEventListener('click', () => this.togglePlay());
    $('#btn-mute').addEventListener('click', () => this.toggleMute());
    $('#btn-pip').addEventListener('click', () => this.togglePip());
    $('#btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    $('#btn-fav').addEventListener('click', () => {
      if (!this.channel) return;
      const on = store.toggleFavorite(this.channel.id);
      this.#syncFavoriteButton();
      toast(on ? 'Añadido a favoritos' : 'Quitado de favoritos', { type: 'ok', timeout: 2000 });
    });

    this.qualitySelect.addEventListener('change', (event) => this.#setQuality(event.target.value));

    $('#player-search').addEventListener('input', (event) => {
      this.#renderList(event.target.value);
      this.#renderGrid(event.target.value);
    });

    for (const tab of this.root.querySelectorAll('.tab')) {
      tab.addEventListener('click', () => {
        for (const other of this.root.querySelectorAll('.tab')) {
          const active = other === tab;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', String(active));
        }
        for (const panel of this.root.querySelectorAll('.player__tabpanel')) {
          panel.classList.toggle('is-active', panel.dataset.panel === tab.dataset.tab);
        }
      });
    }

    // Keep the play/mute glyphs in sync with the media element.
    this.video.addEventListener('play', () => {
      $('#btn-play').textContent = '⏸';
      this.#setLive(true);
      this.#clearError();
    });
    this.video.addEventListener('pause', () => {
      $('#btn-play').textContent = '▶';
      this.#setLive(false);
    });
    this.video.addEventListener('volumechange', () => {
      $('#btn-mute').textContent = this.video.muted || this.video.volume === 0 ? '🔇' : '🔊';
    });
    this.video.addEventListener('waiting', () => this.#setStatus('Buffering…', true));
    this.video.addEventListener('playing', () => {
      if (!this.pendingHost) this.#clearError();
      this.netRetries = 0;
      this.startStats();
    });
    this.video.addEventListener('error', () => {
      if (this.video.error) this.#setStatus('Error de reproducción.', false);
    });
  }

  startStats() {
    clearInterval(this.statsTimer);
    const update = () => {
      const v = this.video;
      if (!v.duration || !Number.isFinite(v.duration)) {
        this.statEl.textContent = 'En vivo';
        return;
      }
      // On a live edge currentTime tracks a sliding window, so report how far
      // behind the live point playback is.
      const behind = Math.max(0, v.duration - v.currentTime);
      this.statEl.textContent = `En vivo · retardo ${behind.toFixed(1)} s`;
    };
    update();
    this.statsTimer = setInterval(update, 1000);
  }

  togglePlay() {
    if (this.video.paused) this.video.play().catch(() => {});
    else this.video.pause();
  }

  toggleMute() {
    this.video.muted = !this.video.muted;
  }

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      toast('Este navegador no admite imagen en imagen.', { type: 'warn' });
    }
  }

  toggleFullscreen() {
    const target = this.root.querySelector('.player__shell') ?? this.root;
    if (document.fullscreenElement) document.exitFullscreen();
    else target.requestFullscreen?.().catch(() => {});
  }

  syncFavoriteButton() {
    this.#syncFavoriteButton();
  }

  refreshLists() {
    const query = $('#player-search').value;
    this.#renderList(query);
    this.#renderGrid(query);
  }
}

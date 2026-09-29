import { api } from './api.js';
import { store } from './store.js';
import { Player } from './player.js';
import {
  $, $$, debounce, el, fmtTime, fmtRange, fold, initials, restoreFocus, setBackgroundInert, toast, trapTab,
} from './util.js';

const state = {
  channels: [],
  groups: [],
  status: {},
  guides: {},
  query: '',
  group: 'all',
  view: 'channels',
  epgReady: false,
};

const VIEWS = new Set(['channels', 'favorites', 'epg', 'settings']);

const dom = {
  main: $('#main'),
  sidebar: $('#sidebar'),
  scrim: $('#sidebar-scrim'),
  menuBtn: $('#btn-menu'),
  nav: $('#main-nav'),
  navCountChannels: $('#nav-count-channels'),
  navCountFav: $('#nav-count-fav'),
  navCountEpg: $('#nav-count-epg'),
  grid: $('#channel-grid'),
  favoritesGrid: $('#favorites-grid'),
  favoritesEmpty: $('#favorites-empty'),
  favoritesSub: $('#favorites-sub'),
  channelsSub: $('#channels-sub'),
  epgList: $('#epg-list'),
  epgEmpty: $('#epg-empty'),
  epgSub: $('#epg-sub'),
  chips: $('#group-chips'),
  empty: $('#empty-state'),
  banner: $('#status-banner'),
  statusWrap: $('#playlist-status-wrap'),
  playlistStatus: $('#playlist-status'),
  search: $('#search'),
  searchClear: $('#search-clear'),
  help: $('#help-modal'),
  helpEpg: $('#help-epg'),
};

const player = new Player({
  getChannels: () => filteredChannels(),
  onChange: () => render(),
});

/* ------------------------------------------------------------------ *
 * Data
 * ------------------------------------------------------------------ */

async function loadChannels() {
  try {
    const data = await api.channels();
    state.channels = data.channels;
    state.groups = data.groups;
    state.status = data.status ?? {};
    dom.playlistStatus.textContent = `${data.channels.length} canales · ${data.country}`;
    dom.statusWrap.dataset.state = 'ok';
    $('#fact-playlist').textContent = `${data.channels.length} canales de ${data.country}`;
    clearBanner();
    renderNav();
    applySettings();
    render();
  } catch (err) {
    dom.playlistStatus.textContent = 'No se pudo cargar la lista';
    dom.statusWrap.dataset.state = 'error';
    showBanner(`Error al cargar los canales: ${err.message}`, 'error');
  }
}

async function loadEpg() {
  try {
    const data = await api.epgOverview();
    state.guides = data.guides ?? {};
    state.epgReady = Boolean(data.status?.state === 'ready');

    if (state.epgReady) {
      const source = data.status.sources?.[0];
      const matched = Object.values(state.guides).filter((g) => g.matched).length;
      const window = source?.window
        ? ` · cubre ${new Date(source.window.from).toLocaleDateString('es-CR')} – ${new Date(source.window.to).toLocaleDateString('es-CR')}`
        : '';
      dom.helpEpg.textContent =
        `Fuente: ${source?.name ?? 'desconocida'} (${source?.programmes ?? 0} programas, ${source?.channels ?? 0} canales). ` +
        `La guía coincide con ${matched} de los ${state.channels.length} canales de la lista${window}. ` +
        'Los canales locales pequeños suelen no tener guía publicada.';
      $('#fact-epg').textContent = `${source?.name ?? 'desconocida'} · ${matched}/${state.channels.length} canales con guía`;
    } else if (data.status?.message) {
      showBanner(`Guía de programación: ${data.status.message}`, 'warn');
      $('#fact-epg').textContent = data.status.message;
    }
    render();
  } catch (err) {
    showBanner(`No se pudo cargar la guía: ${err.message}`, 'warn');
    $('#fact-epg').textContent = `No disponible: ${err.message}`;
  }
}

const checkButtons = ['#btn-check', '#btn-check-2'].map((selector) => $(selector));
const refreshButtons = ['#btn-refresh', '#btn-refresh-2'].map((selector) => $(selector));

const checkIcon = (label) =>
  `<svg class="icon" aria-hidden="true"><use href="#i-pulse"></use></svg><span class="btn__label">${label}</span>`;

/** Comprobación por bloques: nunca satura el servidor ni bloquea la interfaz. */
async function runCheck() {
  for (const button of checkButtons) {
    if (!button) continue;
    button.disabled = true;
    button.innerHTML = checkIcon('Comprobando… 0');
  }

  const ids = state.channels.map((channel) => channel.id);
  const CHUNK = 12;

  try {
    let done = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const data = await api.check(chunk);
      Object.assign(state.status, data.status ?? {});
      done += chunk.length;
      for (const button of checkButtons) {
        if (button) button.innerHTML = checkIcon(`Comprobando… ${done}/${ids.length}`);
      }
      render();
    }
    const values = Object.values(state.status);
    const dead = values.filter((s) => !s.ok).length;
    const online = values.length - dead;
    toast(`Comprobación terminada: ${online} en vivo, ${dead} con problemas.`, {
      type: dead ? 'warn' : 'ok',
      timeout: 6000,
    });
    render();
  } catch (err) {
    toast(`Falló la comprobación: ${err.message}`, { type: 'error' });
  } finally {
    for (const button of checkButtons) {
      if (!button) continue;
      button.disabled = false;
      button.innerHTML = checkIcon('Comprobar');
    }
  }
}

async function refreshAll() {
  for (const button of refreshButtons) {
    if (!button) continue;
    button.disabled = true;
    button.classList.add('is-spinning');
  }
  try {
    const data = await api.refreshPlaylist();
    state.channels = data.channels;
    state.groups = data.groups;
    renderNav();
    render();
    toast(`Lista actualizada: ${data.channels.length} canales.`, { type: 'ok' });
    await loadEpg();
  } catch (err) {
    toast(`No se pudo actualizar: ${err.message}`, { type: 'error' });
  } finally {
    for (const button of refreshButtons) {
      if (!button) continue;
      button.disabled = false;
      button.classList.remove('is-spinning');
    }
  }
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

function filteredChannels() {
  const query = fold(state.query);
  const { hideOffline } = store.settings;

  return state.channels.filter((channel) => {
    if (state.group !== 'all' && !channel.groups.includes(state.group)) return false;
    if (hideOffline && state.status[channel.id] && !state.status[channel.id].ok) return false;
    if (!query) return true;
    return (
      fold(channel.name).includes(query) ||
      fold(channel.groups.join(' ')).includes(query) ||
      fold((channel.groupLabels ?? []).join(' ')).includes(query) ||
      fold(channel.tvgId).includes(query)
    );
  });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function setView(view) {
  if (!VIEWS.has(view)) return;
  state.view = view;
  for (const section of $$('.view')) {
    section.hidden = section.dataset.view !== view;
    section.classList.toggle('is-active', section.dataset.view === view);
  }
  for (const item of $$('.nav__item')) {
    const active = item.dataset.view === view;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  closeSidebar();
  dom.main.scrollTop = 0;
  render();
}

/** Móvil: la navegación lateral se despliega sobre el contenido. */
function setSidebar(open) {
  dom.sidebar.classList.toggle('is-open', open);
  dom.scrim.hidden = !open;
  dom.menuBtn.setAttribute('aria-expanded', String(open));
}
const closeSidebar = () => setSidebar(false);

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderNav() {
  const favorites = store.favorites;

  dom.navCountChannels.textContent = String(state.channels.length);
  dom.navCountFav.textContent = String(favorites.size);

  const chips = [{ name: 'all', label: 'Todos', count: state.channels.length }, ...state.groups];

  dom.chips.replaceChildren(
    ...chips.map((group) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${state.group === group.name ? ' is-active' : ''}`,
          'aria-pressed': String(state.group === group.name),
          onclick: () => {
            state.group = group.name;
            renderNav();
            render();
          },
        },
        [
          group.label,
          el('span', { class: 'chip__count', text: String(group.count) }),
        ],
      ),
    ),
  );
}

function channelState(status) {
  if (status?.ok) return { className: 'is-live', label: 'En vivo' };
  if (status && !status.ok) return { className: 'is-dead', label: 'Caído' };
  return { className: '', label: '' };
}

function renderCard(channel) {
  const status = state.status[channel.id];
  const favorite = store.isFavorite(channel.id);
  const live = channelState(status);

  const badges = [
    channel.qualityTag
      ? el('span', { class: `badge badge--${channel.qualityTag === 'SD' ? 'sd' : 'hd'}`, text: channel.qualityTag })
      : channel.resolution
        ? el('span', { class: 'badge badge--hd', text: channel.resolution.toUpperCase() })
        : null,
    channel.geoBlocked ? el('span', { class: 'badge badge--geo', title: 'Restringido geográficamente', text: 'Geo' }) : null,
    status && !status.ok ? el('span', { class: 'badge badge--off', title: status.reason || 'Sin señal', text: 'Caído' }) : null,
  ].filter(Boolean);

  const epg = epgLines(channel.id);
  const showEpg = store.settings.showEpg && state.epgReady;

  return el(
    'div',
    {
      class: `card${live.className ? ` ${live.className}` : ''}`,
      role: 'listitem',
      dataset: { id: channel.id },
    },
    [
      el('button', { type: 'button', class: 'card__main', onclick: () => openPlayer(channel) }, [
        el('span', { class: 'card__logo-wrap' }, [
          channel.logo
            ? el('img', {
                class: 'card__logo',
                src: `/img?u=${encodeURIComponent(channel.logo)}`,
                alt: '',
                loading: 'lazy',
                referrerPolicy: 'no-referrer',
                onerror: (event) => {
                  // Swap in a monogram when the logo host is unreachable.
                  const fallback = el('span', { class: 'card__logo-fallback', text: initials(channel.name) });
                  event.target.replaceWith(fallback);
                },
              })
            : el('span', { class: 'card__logo-fallback', text: initials(channel.name) }),
          el('span', { class: 'card__number', text: String(channel.number) }),
        ]),
        el('span', { class: 'card__body' }, [
          el('span', { class: 'card__name', text: channel.name }),
          el('span', { class: 'card__meta' }, [
            el('span', { class: 'card__group', text: channel.groupLabels?.[0] ?? channel.groups[0] }),
            ...badges,
          ]),
        ]),
        showEpg
          ? el(
              'span',
              { class: 'card__epg' },
              epg ?? [el('span', { class: 'epg-line epg-line--empty' }, [el('span', { class: 'epg-line__title', text: 'Sin guía' })])],
            )
          : null,
        el('span', { class: 'card__state' }, [
          el('span', { class: 'dot' }),
          el('span', { text: live.label }),
        ]),
      ]),
      el('button', {
        type: 'button',
        class: `card__fav${favorite ? ' is-on' : ''}`,
        'aria-pressed': String(favorite),
        'aria-label': favorite ? `Quitar ${channel.name} de favoritos` : `Añadir ${channel.name} a favoritos`,
        title: favorite ? 'Quitar de favoritos' : 'Añadir a favoritos',
        text: favorite ? '★' : '☆',
        onclick: () => store.toggleFavorite(channel.id),
      }),
    ],
  );
}

function epgLines(channelId) {
  const guide = state.guides[channelId];
  if (!guide?.matched || !guide.now) return null;
  const node = (programme, className) =>
    el('span', { class: `epg-line ${className ?? ''}`.trim() }, [
      el('span', { class: 'epg-line__time', text: fmtTime(programme.start) }),
      el('span', { class: 'epg-line__title', text: programme.title || 'Sin título' }),
    ]);
  return [node(guide.now), guide.next ? node(guide.next, 'epg-line--next') : null].filter(Boolean);
}

/** Programación en curso: "Canal → Ahora → Próximo" con avance del programa. */
function renderGuide() {
  const entries = state.channels
    .map((channel) => ({ channel, guide: state.guides[channel.id] }))
    .filter(({ guide }) => guide?.matched && guide.now);

  dom.navCountEpg.textContent = String(entries.length);
  dom.epgSub.textContent = state.epgReady
    ? `${plural(entries.length, 'canal con', 'canales con')} programación disponible`
    : 'La guía todavía no está disponible';

  if (!entries.length) {
    dom.epgList.replaceChildren();
    dom.epgEmpty.hidden = false;
    return;
  }
  dom.epgEmpty.hidden = true;

  const now = Date.now();
  dom.epgList.replaceChildren(
    ...entries.map(({ channel, guide }) => {
      const { start, stop } = guide.now;
      const progress = Math.min(100, Math.max(0, ((now - start) / (stop - start)) * 100));

      return el('div', { class: 'guide__item' }, [
        el('div', { class: 'guide__channel' }, [
          channel.logo
            ? el('img', {
                class: 'guide__logo',
                src: `/img?u=${encodeURIComponent(channel.logo)}`,
                alt: '',
                loading: 'lazy',
                referrerPolicy: 'no-referrer',
                onerror: (event) => event.target.replaceWith(el('span', { class: 'card__logo-fallback', text: initials(channel.name) })),
              })
            : el('span', { class: 'card__logo-fallback', text: initials(channel.name) }),
          el('span', { class: 'guide__channel-name', text: channel.name }),
        ]),
        el('div', { class: 'guide__slot guide__slot--now' }, [
          el('span', { class: 'guide__label' }, [
            el('span', { text: 'Ahora' }),
            el('span', { class: 'guide__time', text: fmtRange(start, stop) }),
          ]),
          el('span', { class: 'guide__title', text: guide.now.title || 'Sin título' }),
          el('span', { class: 'progress', dataset: { start: String(start), stop: String(stop) } }, [
            el('span', { class: 'progress__bar', style: `--p:${progress.toFixed(1)}%` }),
          ]),
        ]),
        el('div', { class: 'guide__slot guide__slot--next' }, [
          el('span', { class: 'guide__label' }, [
            el('span', { text: 'Luego' }),
            guide.next ? el('span', { class: 'guide__time', text: fmtTime(guide.next.start) }) : null,
          ]),
          el('span', {
            class: guide.next ? 'guide__title' : 'guide__empty',
            text: guide.next?.title || 'Sin más programación hoy',
          }),
        ]),
        el('button', {
          type: 'button',
          class: 'icon-btn guide__play',
          title: `Reproducir ${channel.name}`,
          'aria-label': `Reproducir ${channel.name}`,
          html: '<svg class="icon" aria-hidden="true"><use href="#i-play"></use></svg>',
          onclick: () => openPlayer(channel),
        }),
      ]);
    }),
  );
}

/** Avances de los programas en curso, sin volver a renderizar la lista. */
function tickProgress() {
  const now = Date.now();
  for (const bar of $$('#epg-list .progress')) {
    const { start, stop } = bar.dataset;
    const span = Number(stop) - Number(start);
    if (!span) continue;
    const value = Math.min(100, Math.max(0, ((now - Number(start)) / span) * 100));
    bar.querySelector('.progress__bar')?.style.setProperty('--p', `${value.toFixed(1)}%`);
  }
}

function emptyMessage() {
  if (state.query) return `Ningún canal coincide con «${state.query}».`;
  if (state.group !== 'all') return 'No hay canales en esta categoría.';
  if (store.settings.hideOffline) return 'No hay canales con los filtros actuales.';
  return 'No hay canales para mostrar.';
}

function render() {
  const list = filteredChannels();
  const favorites = list.filter((channel) => store.isFavorite(channel.id));
  const live = list.filter((channel) => state.status[channel.id]?.ok).length;

  dom.grid.replaceChildren(...list.map(renderCard));
  dom.empty.hidden = list.length > 0;
  if (!dom.empty.hidden) dom.empty.textContent = emptyMessage();

  dom.favoritesGrid.replaceChildren(...favorites.map(renderCard));
  dom.favoritesEmpty.hidden = favorites.length > 0;
  dom.favoritesSub.textContent = favorites.length
    ? `${plural(favorites.length, 'canal guardado', 'canales guardados')}`
    : 'Sin canales guardados todavía';

  const groupLabel = state.group === 'all' ? 'Todas las categorías' : state.groups.find((g) => g.name === state.group)?.label;
  dom.channelsSub.textContent =
    `${plural(list.length, 'canal', 'canales')}` +
    (state.group === 'all' ? ' · Costa Rica' : ` · ${groupLabel}`) +
    (live ? ` · ${live} en vivo` : '');

  renderGuide();
  // Los dos interruptores (lista y ajustes) reflejan siempre la misma preferencia.
  applySettings();

  $('#btn-fav').classList.toggle('is-on', false);
  player.syncFavoriteButton();
  if (player.isOpen) player.refreshLists();
}

let bannerTimer = null;

function showBanner(message, kind = 'info') {
  dom.banner.textContent = message;
  dom.banner.className = `status-banner is-${kind}`;
  dom.banner.hidden = false;
  clearTimeout(bannerTimer);
  // Los avisos no bloqueantes se ocultan solos; los errores quedan hasta actuar.
  if (kind !== 'error') bannerTimer = setTimeout(clearBanner, 20000);
}

function clearBanner() {
  clearTimeout(bannerTimer);
  dom.banner.hidden = true;
}

function openPlayer(channel) {
  clearBanner();
  player.open(channel);
}

function applySettings() {
  const { hideOffline, showEpg } = store.settings;
  for (const input of [$('#hide-offline'), $('#hide-offline-2')]) if (input) input.checked = hideOffline;
  for (const input of [$('#show-epg'), $('#show-epg-2')]) if (input) input.checked = showEpg;
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

dom.search.addEventListener(
  'input',
  debounce((event) => {
    state.query = event.target.value;
    dom.searchClear.hidden = !state.query;
    render();
  }, 160),
);

dom.searchClear.addEventListener('click', () => {
  dom.search.value = '';
  state.query = '';
  dom.searchClear.hidden = true;
  render();
  dom.search.focus();
});

for (const input of [$('#hide-offline'), $('#hide-offline-2')]) {
  input?.addEventListener('change', (event) => {
    store.setSetting('hideOffline', event.target.checked);
    render();
  });
}

for (const input of [$('#show-epg'), $('#show-epg-2')]) {
  input?.addEventListener('change', (event) => {
    store.setSetting('showEpg', event.target.checked);
    render();
  });
}

dom.nav.addEventListener('click', (event) => {
  const item = event.target.closest('.nav__item');
  if (item) setView(item.dataset.view);
});

dom.menuBtn.addEventListener('click', () => setSidebar(!dom.sidebar.classList.contains('is-open')));
dom.scrim.addEventListener('click', closeSidebar);
// Al volver a ancho de escritorio el cajón se desmonta solo.
window.matchMedia('(min-width: 781px)').addEventListener('change', (event) => {
  if (event.matches) closeSidebar();
});

for (const button of checkButtons) button?.addEventListener('click', runCheck);
for (const button of refreshButtons) button?.addEventListener('click', refreshAll);

let helpReturnFocus = null;

const openHelp = () => {
  helpReturnFocus = document.activeElement;
  closeSidebar();
  dom.help.hidden = false;
  dom.help.setAttribute('aria-hidden', 'false');
  setBackgroundInert(true);
  dom.help.querySelector('.modal__box').focus({ preventScroll: true });
};
const closeHelp = () => {
  dom.help.hidden = true;
  dom.help.setAttribute('aria-hidden', 'true');
  setBackgroundInert(false);
  restoreFocus(helpReturnFocus, $('#btn-help'));
  helpReturnFocus = null;
};

$('#btn-help').addEventListener('click', openHelp);
$('#btn-help-2').addEventListener('click', openHelp);
$('#btn-help-close').addEventListener('click', closeHelp);
dom.help.addEventListener('click', (event) => {
  if (event.target === dom.help) closeHelp();
});

document.addEventListener('keydown', (event) => {
  // Con un modal abierto, Tab nunca sale de él.
  if (event.key === 'Tab') {
    const modal = !dom.help.hidden
      ? dom.help.querySelector('.modal__box')
      : player.isOpen
        ? document.querySelector('.player__shell')
        : null;
    if (modal) trapTab(modal, event);
    return;
  }

  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  const key = event.key.toLowerCase();
  const modalOpen = player.isOpen || !dom.help.hidden;

  if (key === 'escape') {
    if (!dom.help.hidden) return closeHelp();
    if (dom.sidebar.classList.contains('is-open')) return closeSidebar();
    if (player.isOpen) return player.close();
    return;
  }

  if (typing) return;

  if (key === '/' && !modalOpen) {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
    return;
  }

  if (key === 'enter' && !modalOpen) {
    const first = (state.view === 'favorites'
      ? filteredChannels().filter((channel) => store.isFavorite(channel.id))
      : filteredChannels())[0];
    if (first) {
      event.preventDefault();
      openPlayer(first);
    }
    return;
  }

  if (!player.isOpen) return;

  switch (key) {
    case 'arrowleft':
      event.preventDefault();
      player.step(-1);
      break;
    case 'arrowright':
      event.preventDefault();
      player.step(1);
      break;
    case ' ':
      event.preventDefault();
      player.togglePlay();
      break;
    case 'm':
      player.toggleMute();
      break;
    case 'f':
      player.toggleFullscreen();
      break;
    case 'p':
      player.togglePip();
      break;
    case 's':
      $('#btn-fav').click();
      break;
    case 'g':
      player.close();
      setView('favorites');
      break;
    default:
      break;
  }
});

// Re-render the grid when favorites change from anywhere in the UI.
store.onChange(() => {
  renderNav();
  render();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

applySettings();
await loadChannels();
loadEpg();
// Refresh "En curso" labels, progress bars and the live-status badges.
setInterval(loadEpg, 5 * 60_000);
setInterval(tickProgress, 60_000);

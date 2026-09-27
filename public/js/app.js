import { api } from './api.js';
import { store } from './store.js';
import { Player } from './player.js';
import { $, $$, debounce, el, fmtTime, fold, initials, toast } from './util.js';

const state = {
  channels: [],
  groups: [],
  status: {},
  guides: {},
  query: '',
  group: 'all',
  epgReady: false,
};

const dom = {
  grid: $('#channel-grid'),
  chips: $('#group-chips'),
  empty: $('#empty-state'),
  banner: $('#status-banner'),
  playlistStatus: $('#playlist-status'),
  search: $('#search'),
  searchClear: $('#search-clear'),
  hideOffline: $('#hide-offline'),
  showEpg: $('#show-epg'),
  help: $('#help-modal'),
  helpEpg: $('#help-epg'),
};

const player = new Player({
  getChannels: () => filteredChannels(),
  onClose: () => dom.search.blur(),
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
    renderChips();
    applySettings();
    render();
  } catch (err) {
    dom.playlistStatus.textContent = 'No se pudo cargar la lista';
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
    } else if (data.status?.message) {
      showBanner(`Guía de programación: ${data.status.message}`, 'warn');
    }
    render();
  } catch (err) {
    showBanner(`No se pudo cargar la guía: ${err.message}`, 'warn');
  }
}

async function runCheck(button) {
  button?.classList.add('is-spinning');
  button?.setAttribute('disabled', '');
  const original = button?.innerHTML;
  if (button) button.innerHTML = '<span>⏳</span> <span class="btn__label">Comprobando…</span>';

  try {
    const data = await api.check();
    state.status = data.status ?? {};
    const values = Object.values(state.status);
    const dead = values.filter((s) => !s.ok).length;
    const offline = values.length - dead;
    toast(`Comprobación terminada: ${offline} en vivo, ${dead} con problemas.`, {
      type: dead ? 'warn' : 'ok',
      timeout: 6000,
    });
    render();
  } catch (err) {
    toast(`Falló la comprobación: ${err.message}`, { type: 'error' });
  } finally {
    button?.classList.remove('is-spinning');
    button?.removeAttribute('disabled');
    if (button && original) button.innerHTML = original;
  }
}

/* ------------------------------------------------------------------ *
 * Filtering
 * ------------------------------------------------------------------ */

function filteredChannels() {
  const query = fold(state.query);
  const favorites = store.favorites;
  const { hideOffline } = store.settings;

  return state.channels.filter((channel) => {
    if (state.group === 'favorites' && !favorites.has(channel.id)) return false;
    if (state.group !== 'all' && state.group !== 'favorites' && !channel.groups.includes(state.group)) return false;
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

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderChips() {
  const favorites = store.favorites;
  const chips = [
    { name: 'all', label: 'Todos', count: state.channels.length },
    { name: 'favorites', label: '★ Favoritos', count: favorites.size },
    ...state.groups,
  ];

  dom.chips.replaceChildren(
    ...chips.map((group) =>
      el(
        'button',
        {
          type: 'button',
          class: `chip${state.group === group.name ? ' is-active' : ''}`,
          onclick: () => {
            state.group = group.name;
            renderChips();
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

function epgLines(channelId) {
  const guide = state.guides[channelId];
  if (!guide?.matched || !guide.now) return null;
  const node = (programme, className) =>
    el('div', { class: `epg-line ${className ?? ''}`.trim() }, [
      el('span', { class: 'epg-line__time', text: fmtTime(programme.start) }),
      el('span', { class: 'epg-line__title', text: programme.title || 'Sin título' }),
    ]);
  return [node(guide.now), guide.next ? node(guide.next, 'epg-line--next') : null].filter(Boolean);
}

function renderCard(channel) {
  const status = state.status[channel.id];
  const favorite = store.isFavorite(channel.id);

  const badges = [
    channel.qualityTag
      ? el('span', { class: `badge badge--${channel.qualityTag === 'SD' ? 'sd' : 'hd'}`, text: channel.qualityTag })
      : channel.resolution
        ? el('span', { class: 'badge badge--hd', text: channel.resolution.toUpperCase() })
        : null,
    channel.geoBlocked ? el('span', { class: 'badge badge--geo', title: 'Restringido geográficamente', text: 'Geo' }) : null,
    status && !status.ok ? el('span', { class: 'badge badge--off', title: status.reason || 'Sin señal', text: 'Caído' }) : null,
  ].filter(Boolean);

  return el(
    'button',
    {
      type: 'button',
      class: `card${status && !status.ok ? ' is-offline' : ''}`,
      role: 'listitem',
      dataset: { id: channel.id },
      onclick: () => openPlayer(channel),
    },
    [
      el('span', {
        class: 'card__fav',
        role: 'button',
        tabIndex: 0,
        title: favorite ? 'Quitar de favoritos' : 'Añadir a favoritos',
        text: favorite ? '★' : '☆',
        onclick: (event) => {
          event.stopPropagation();
          store.toggleFavorite(channel.id);
        },
        onkeydown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            store.toggleFavorite(channel.id);
          }
        },
      }),
      el('div', { class: 'card__logo-wrap' }, [
        el('span', { class: 'card__number', text: String(channel.number) }),
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
      ]),
      el('div', { class: 'card__body' }, [
        el('span', { class: 'card__name', text: channel.name }),
        el('div', { class: 'card__meta' }, [el('span', { class: 'card__group', text: channel.groupLabels?.[0] ?? channel.groups[0] }), ...badges]),
      ]),
      store.settings.showEpg && state.epgReady
        ? el('div', { class: 'card__epg' }, epgLines(channel.id) ?? [
            el('div', { class: 'epg-line' }, [
              el('span', { class: 'epg-line__title', text: 'Sin guía disponible' }),
            ]),
          ])
        : null,
    ],
  );
}

function render() {
  const list = filteredChannels();
  dom.grid.replaceChildren(...list.map(renderCard));
  dom.empty.hidden = list.length > 0;
  $('#btn-fav').classList.toggle('is-on', false);
  player.syncFavoriteButton();
  if (player.isOpen) player.refreshLists();
}

function showBanner(message, kind = 'info') {
  dom.banner.textContent = message;
  dom.banner.className = `status-banner is-${kind}`;
  dom.banner.hidden = false;
}

function clearBanner() {
  dom.banner.hidden = true;
}

function openPlayer(channel) {
  clearBanner();
  player.open(channel);
}

function applySettings() {
  const { hideOffline, showEpg } = store.settings;
  dom.hideOffline.checked = hideOffline;
  dom.showEpg.checked = showEpg;
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

dom.hideOffline.addEventListener('change', (event) => {
  store.setSetting('hideOffline', event.target.checked);
  render();
});

dom.showEpg.addEventListener('change', (event) => {
  store.setSetting('showEpg', event.target.checked);
  render();
});

$('#btn-check').addEventListener('click', (event) => runCheck(event.currentTarget));

$('#btn-refresh').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.classList.add('is-spinning');
  button.setAttribute('disabled', '');
  try {
    const data = await api.refreshPlaylist();
    state.channels = data.channels;
    state.groups = data.groups;
    renderChips();
    render();
    toast(`Lista actualizada: ${data.channels.length} canales.`, { type: 'ok' });
    loadEpg();
  } catch (err) {
    toast(`No se pudo actualizar: ${err.message}`, { type: 'error' });
  } finally {
    button.classList.remove('is-spinning');
    button.removeAttribute('disabled');
  }
});

const openHelp = () => {
  dom.help.hidden = false;
  dom.help.setAttribute('aria-hidden', 'false');
};
const closeHelp = () => {
  dom.help.hidden = true;
  dom.help.setAttribute('aria-hidden', 'true');
};

$('#btn-help').addEventListener('click', openHelp);
$('#btn-help-close').addEventListener('click', closeHelp);
dom.help.addEventListener('click', (event) => {
  if (event.target === dom.help) closeHelp();
});

document.addEventListener('keydown', (event) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName);
  const key = event.key.toLowerCase();

  if (key === 'escape') {
    if (!dom.help.hidden) return closeHelp();
    if (player.isOpen) return player.close();
    return;
  }

  if (typing) return;

  if (key === '/') {
    event.preventDefault();
    dom.search.focus();
    dom.search.select();
    return;
  }

  if (key === 'enter' && !player.isOpen) {
    const first = filteredChannels()[0];
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
      state.group = 'favorites';
      renderChips();
      render();
      break;
    default:
      break;
  }
});

// Re-render the grid when favorites change from anywhere in the UI.
store.onChange(() => {
  renderChips();
  render();
});

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

applySettings();
await loadChannels();
loadEpg();
// Refresh "En curso" labels and the live-status badges periodically.
setInterval(loadEpg, 5 * 60_000);

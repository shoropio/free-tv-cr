/** Channel timezone: the guide is published for Costa Rica, so times are shown
 *  in America/Costa_Rica regardless of where the viewer is. */
export const GUIDE_TZ = 'America/Costa_Rica';

const timeFmt = new Intl.DateTimeFormat('es-CR', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: GUIDE_TZ,
});

const dayFmt = new Intl.DateTimeFormat('es-CR', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: GUIDE_TZ,
});

/** `20:35` in guide time. */
export const fmtTime = (ms) => (ms ? timeFmt.format(new Date(ms)) : '--:--');

/** `20:35 – 21:30` in guide time. */
export const fmtRange = (start, stop) => `${fmtTime(start)} – ${fmtTime(stop)}`;

/** Human label for a programme relative to now: "En curso", "Dentro de 12 min". */
export function relativeLabel(start, stop, now = Date.now()) {
  if (!start) return '';
  if (now >= start && now < stop) return 'En curso';
  if (now < start) {
    const mins = Math.round((start - now) / 60000);
    if (mins < 1) return 'Ahora';
    if (mins < 60) return `En ${mins} min`;
    const hours = Math.floor(mins / 60);
    return `En ${hours} h ${mins % 60} min`;
  }
  return 'Terminó';
}

export const isPast = (programme, now = Date.now()) => !!programme && programme.stop <= now;
export const isCurrent = (programme, now = Date.now()) => !!programme && programme.start <= now && now < programme.stop;

export const fmtDay = (ms) => (ms ? dayFmt.format(new Date(ms)) : '');

export function fmtBitrate(bps) {
  if (!bps) return '';
  return bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1e3)} kbps`;
}

export function fmtDuration(minutes) {
  if (minutes <= 0) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** Two-letter monogram used when a channel has no usable logo. */
export function initials(name) {
  const words = String(name || '?')
    .replace(/\(.*?\)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function debounce(fn, wait = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** Normalises text for accent-insensitive search. */
export const fold = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

export const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Builds a DOM element: el('div', {class:'x', onclick:fn}, [children|strings]) */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

/* ------------------------------------------------------------------ *
 * Modal focus management
 * ------------------------------------------------------------------ */

const FOCUSABLE_SEL =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), video[controls], [tabindex]:not([tabindex="-1"])';

/** Focusable descendants of `container` that are actually rendered. */
const focusableIn = (container) =>
  [...container.querySelectorAll(FOCUSABLE_SEL)].filter((node) => node.getClientRects().length > 0);

/**
 * Keeps Tab inside `container` while a modal is open. Call from a document
 * keydown listener; the default is only prevented when focus would escape.
 */
export function trapTab(container, event) {
  const nodes = focusableIn(container);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (!container.contains(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus({ preventScroll: true });
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

/** Page content hidden from clicks and screen readers while a modal is open. */
const BACKGROUND = ['.skip-link', '.app'];

export function setBackgroundInert(on) {
  for (const selector of BACKGROUND) document.querySelector(selector)?.toggleAttribute('inert', on);
}

/** Returns focus to where it was before the modal opened (or to `fallback`). */
export function restoreFocus(previous, fallback) {
  const target = previous?.isConnected ? previous : fallback;
  if (target?.isConnected) target.focus({ preventScroll: true });
}

/* ------------------------------------------------------------------ *
 * Toasts
 * ------------------------------------------------------------------ */

const toastHost = () => document.getElementById('toasts');

export function toast(message, { type = 'info', timeout = 5000, actions = [] } = {}) {
  const host = toastHost();
  if (!host) return () => {};

  const node = el('div', { class: `toast is-${type}` }, [
    el('div', { text: message }),
  ]);

  if (actions.length) {
    const row = el('div', { class: 'toast__actions' });
    for (const action of actions) {
      row.append(
        el('button', {
          type: 'button',
          class: action.ghost ? 'ghost' : '',
          text: action.label,
          onclick: () => {
            action.onClick?.();
            dismiss();
          },
        }),
      );
    }
    node.append(row);
  }

  const dismiss = () => {
    clearTimeout(timer);
    node.style.opacity = '0';
    node.style.transform = 'translateY(8px)';
    node.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => node.remove(), 220);
  };

  const timer = timeout ? setTimeout(dismiss, timeout) : null;
  host.append(node);
  return dismiss;
}

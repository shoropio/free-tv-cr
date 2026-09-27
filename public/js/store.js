/** Small typed wrapper over the localStorage-backed preferences. */
const KEY = 'iptv-cr:v1';

const defaults = {
  favorites: [],
  settings: {
    hideOffline: false,
    showEpg: true,
  },
};

let state = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(defaults);
    const parsed = JSON.parse(raw);
    return {
      favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
      settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
    };
  } catch {
    return structuredClone(defaults);
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* private mode / quota: preferences just won't survive a reload */
  }
}

const listeners = new Set();

export const store = {
  get favorites() {
    return new Set(state.favorites);
  },
  get settings() {
    return { ...state.settings };
  },
  isFavorite(id) {
    return state.favorites.includes(id);
  },
  toggleFavorite(id) {
    const index = state.favorites.indexOf(id);
    if (index === -1) state.favorites.push(id);
    else state.favorites.splice(index, 1);
    persist();
    listeners.forEach((fn) => fn());
    return this.isFavorite(id);
  },
  setSetting(key, value) {
    state.settings[key] = value;
    persist();
    listeners.forEach((fn) => fn());
  },
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

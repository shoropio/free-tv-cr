async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { ok: false, error: text.slice(0, 300) };
  }
  if (!response.ok) {
    const err = new Error(data?.error || `HTTP ${response.status}`);
    err.status = response.status;
    err.payload = data;
    throw err;
  }
  return data;
}

export const api = {
  channels: () => request('/api/channels'),
  epgOverview: () => request('/api/epg'),
  epgTimeline: (channelId) => request(`/api/epg/${encodeURIComponent(channelId)}`),
  refreshPlaylist: () => request('/api/playlist/refresh', { method: 'POST' }),
  refreshEpg: () => request('/api/epg/refresh', { method: 'POST' }),
  check: (ids = null) =>
    request('/api/check', { method: 'POST', body: JSON.stringify({ ids, deep: true }) }),
  allowHost: (host) => request('/api/allow-host', { method: 'POST', body: JSON.stringify({ host }) }),
};

(() => {
  const storage = {
    get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* Storage can be unavailable in private browsing. */ } },
  };
  const apiBase = (window.APP_CONFIG?.apiBase || '').replace(/\/+$/, '');
  const apiOrigin = apiBase ? new URL(apiBase, window.location.href).origin : window.location.origin;
  const crossOrigin = apiOrigin !== window.location.origin;
  const deviceKey = `weddingDevice:${apiOrigin}`;
  let deviceToken = crossOrigin ? storage.get(deviceKey) : '';
  const resolveUrl = path => {
    if (/^https?:\/\//i.test(path)) return path;
    return apiBase ? `${apiBase}/${path.replace(/^\/+/, '')}` : path;
  };
  const loginUrl = resolveUrl('/login');
  async function request(url, options = {}) {
    const headers = { ...options.headers };
    if (crossOrigin && deviceToken) headers['X-Wedding-Device'] = deviceToken;
    const response = await fetch(resolveUrl(url), {
      ...options, headers, credentials: crossOrigin ? 'omit' : 'same-origin', cache: 'no-store',
    });
    // A signed anonymous identifier keeps "this browser" working even when the
    // browser blocks third-party cookies between GitHub Pages and DuckDNS.
    const issuedToken = crossOrigin ? response.headers.get('X-Wedding-Device') : null;
    if (issuedToken) { deviceToken = issuedToken; storage.set(deviceKey, deviceToken); }
    if (response.status === 401) window.location.assign(loginUrl);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'The server is unavailable. Please try again.');
    return payload;
  }
  const config = request('/api/config');
  async function json(url, options) {
    // Bootstrap identity before concurrent remote calls can issue different IDs.
    if (crossOrigin) await config;
    return request(url, options);
  }
  window.Wedding = { json, storage, config, resolveUrl, loginUrl, getDeviceToken: () => crossOrigin ? deviceToken : '' };
})();

(() => {
  const storage = {
    get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* Cookies still keep the server session. */ } },
  };
  async function json(url, options = {}) {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) window.location.assign('/login');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'The server is unavailable. Please try again.');
    return payload;
  }
  window.Wedding = { json, storage, config: json('/api/config') };
})();

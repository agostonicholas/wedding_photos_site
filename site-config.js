// GitHub Pages hosts the invitation frontend; the home server hosts the API.
// Pages opened directly on the home server keep using their own origin.
window.APP_CONFIG = {
  ...window.APP_CONFIG,
  apiBase: window.APP_CONFIG?.apiBase ?? (
    window.location.hostname === 'agostonicholas.github.io'
      ? 'https://nickserverphotodump.duckdns.org'
      : ''
  ),
};

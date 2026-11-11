const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Browser condition did not complete');
}
function page(t, name, handlers, options = {}) {
  const dom = new JSDOM(source(name), { url: options.url || 'http://127.0.0.1:4000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  const intervals = [];
  const requests = [];
  window.setInterval = (callback, duration) => { intervals.push({ callback, duration }); return intervals.length; };
  window.fetch = async (url, requestOptions) => {
    requests.push({ url, options: requestOptions });
    const value = await handlers(url, requestOptions);
    return { status: 200, ok: true, headers: { get: name => options.responseHeaders?.[name] || null }, json: async () => value };
  };
  return { window, intervals, requests, run: name => window.eval(source(name)) };
}
const config = { ok: true, maxFiles: 2, maxTotalBytes: 1000, allowedTypes: ['image/png'] };

test('uploader loads server limits and renders untrusted filenames as text', async t => {
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
  view.window.localStorage.setItem('weddingUploaderName', 'Guest');
  view.run('client.js'); view.run('app.js');
  const document = view.window.document;
  await waitFor(() => !document.getElementById('photos').disabled);
  assert.equal(document.getElementById('photos').accept, 'image/png');
  assert.match(document.getElementById('picker-hint').textContent, /2 max/);
  const input = document.getElementById('photos');
  const filename = '<img src=x onerror="alert(1)">.png';
  Object.defineProperty(input, 'files', { configurable: true, value: [new view.window.File(['data'], filename, { type: 'image/png' })] });
  input.dispatchEvent(new view.window.Event('change'));
  assert.equal(document.querySelector('.file-row strong').textContent, filename);
  assert.equal(document.querySelector('.file-row img'), null);
  assert.equal(document.getElementById('upload-btn').disabled, false);
});
test('failed uploads keep files selected, show real progress, and can be retried', async t => {
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
  const { window } = view;
  window.localStorage.setItem('weddingUploaderName', 'Guest');
  let attempt = 0;
  class FakeXHR extends window.EventTarget {
    constructor() { super(); this.upload = new window.EventTarget(); }
    open(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/upload'); }
    send() {
      attempt++;
      queueMicrotask(() => {
        this.upload.dispatchEvent(new window.ProgressEvent('progress', { lengthComputable: true, loaded: 50, total: 100 }));
        assert.equal(window.document.querySelector('progress').value, 50);
        if (attempt === 1) this.dispatchEvent(new window.Event('error'));
        else { this.status = 200; this.responseText = JSON.stringify({ ok: true, files: [{}] }); this.dispatchEvent(new window.Event('load')); }
      });
    }
  }
  window.XMLHttpRequest = FakeXHR;
  view.run('client.js'); view.run('app.js');
  const document = window.document;
  const input = document.getElementById('photos');
  await waitFor(() => !input.disabled);
  let files = [new window.File(['data'], 'photo.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { get: () => files });
  Object.defineProperty(input, 'value', { get: () => files.length ? 'photo.png' : '', set: value => { if (!value) files = []; } });
  input.dispatchEvent(new window.Event('change'));
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => document.getElementById('upload-btn').textContent === 'Retry Upload');
  assert.equal(input.files.length, 1);
  assert.match(document.getElementById('status').textContent, /still selected/);
  assert.equal(input.disabled, false);
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => input.files.length === 0);
  assert.match(document.getElementById('status').textContent, /Uploaded 1/);
});
test('slideshow polls without changing image URLs or rebuilding unchanged slides', async t => {
  const item = { id: 'one', mimetype: 'image/png', url: '/media/0/main-event/2026-01-01/photo.png' };
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [item] });
  view.window.localStorage.setItem('weddingUploaderName', 'Guest');
  view.run('client.js'); view.run('app.js');
  await waitFor(() => view.window.document.querySelector('#slideshow img'));
  const image = view.window.document.querySelector('#slideshow img');
  const refresh = view.intervals.find(interval => interval.duration === 10000);
  assert.ok(refresh);
  await refresh.callback();
  assert.equal(view.window.document.querySelector('#slideshow img'), image);
  assert.equal(image.getAttribute('src'), item.url);
});
test('album polls, preserves safe labels, and requests browser ownership from the server', async t => {
  let count = 0;
  const view = page(t, 'album.html', async url => {
    if (url === '/api/config') return config;
    count++;
    return { ok: true, total: url.includes('mine=true') ? 0 : 1, items: url.includes('mine=true') ? [] : [{ id: 'one', uploaderName: '<img src=x>', url: '/media/0/main-event/2026-01-01/photo.png', uploadedAt: 1 }] };
  });
  view.run('client.js'); view.run('album.js');
  const document = view.window.document;
  await waitFor(() => document.querySelector('.gallery-card'));
  assert.match(document.querySelector('.gallery-card footer').textContent, /<img src=x>/);
  assert.equal(document.querySelectorAll('.gallery-card img').length, 1);
  await view.intervals.find(interval => interval.duration === 10000).callback();
  assert.equal(count, 2);
  document.querySelector('[data-filter="mine"]').click();
  await waitFor(() => document.getElementById('gallery-status').textContent.includes('No photos uploaded'));
  assert.ok(view.requests.some(request => request.url.includes('mine=true')));
  assert.equal(document.querySelectorAll('.gallery-card').length, 0);
});
test('GitHub Pages routes API requests, slideshow images, and uploads to the home backend', async t => {
  const backend = 'https://nickserverphotodump.duckdns.org';
  const token = `${'a'.repeat(32)}.${'b'.repeat(64)}`;
  const item = { id: 'one', mimetype: 'image/png', url: '/media/0/main-event/2026-01-01/photo.png' };
  const view = page(t, 'index.html', async url => url.endsWith('/api/config') ? config : { ok: true, items: [item] }, {
    url: 'https://agostonicholas.github.io/wedding_photos_site/',
    responseHeaders: { 'X-Wedding-Device': token },
  });
  const { window } = view;
  window.localStorage.setItem('weddingUploaderName', 'Guest');
  let uploadUrl;
  const uploadHeaders = {};
  class FakeXHR extends window.EventTarget {
    constructor() { super(); this.upload = new window.EventTarget(); }
    open(method, url) { assert.equal(method, 'POST'); uploadUrl = url; }
    setRequestHeader(name, value) { uploadHeaders[name] = value; }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ ok: true, files: [{}] });
      queueMicrotask(() => this.dispatchEvent(new window.Event('load')));
    }
  }
  window.XMLHttpRequest = FakeXHR;
  view.run('site-config.js'); view.run('client.js'); view.run('app.js');
  const document = window.document;
  const input = document.getElementById('photos');
  await waitFor(() => !input.disabled && document.querySelector('#slideshow img'));
  assert.equal(view.requests[0].url, backend + '/api/config');
  const recent = view.requests.find(request => request.url.endsWith('/api/recent'));
  assert.equal(recent.url, backend + '/api/recent');
  assert.equal(recent.options.headers['X-Wedding-Device'], token);
  assert.equal(recent.options.credentials, 'omit');
  assert.equal(document.querySelector('#slideshow img').src, backend + item.url);
  let files = [new window.File(['data'], 'photo.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { get: () => files });
  Object.defineProperty(input, 'value', { get: () => files.length ? 'photo.png' : '', set: value => { if (!value) files = []; } });
  input.dispatchEvent(new window.Event('change'));
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => !input.files.length);
  assert.equal(uploadUrl, backend + '/upload');
  assert.equal(uploadHeaders['X-Wedding-Device'], token);
  assert.equal(window.localStorage.getItem(`weddingDevice:${backend}`), token);
});
test('GitHub Pages album uses backend URLs for both images and original links', async t => {
  const backend = 'https://nickserverphotodump.duckdns.org';
  const view = page(t, 'album.html', async url => url.endsWith('/api/config') ? config : {
    ok: true, total: 1, items: [{ id: 'one', uploaderName: 'Guest', url: '/media/0/main-event/2026-01-01/photo.png', uploadedAt: 1 }],
  }, { url: 'https://agostonicholas.github.io/wedding_photos_site/album.html' });
  view.run('site-config.js'); view.run('client.js'); view.run('album.js');
  await waitFor(() => view.window.document.querySelector('.gallery-card'));
  for (const element of view.window.document.querySelectorAll('.gallery-card a, .gallery-card img')) {
    assert.ok((element.href || element.src).startsWith(backend + '/media/'));
  }
  assert.ok(view.requests.every(request => request.url.startsWith(backend + '/api/')));
});
test('server-hosted and LAN pages keep using their own origin', async t => {
  const view = page(t, 'index.html', async () => config, { url: 'http://192.168.1.32:4000/' });
  view.run('site-config.js'); view.run('client.js');
  await view.window.Wedding.config;
  assert.equal(view.window.APP_CONFIG.apiBase, '');
  assert.equal(view.requests[0].url, '/api/config');
  assert.equal(view.requests[0].options.credentials, 'same-origin');
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { createConfig } = require('../server/config');
const { createApp } = require('../server');
const { scanGallery } = require('../server/media');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOxoAAAAASUVORK5CYII=', 'base64');
async function setup(t, env = {}, dependencies) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wedding-tests-'));
  const config = createConfig({ NODE_ENV: 'test', PHOTO_STORAGE_ROOT: dir, LEGACY_STORAGE_ROOTS: '', UPLOAD_RATE_LIMIT: '100', ...env });
  const app = await createApp(config, dependencies);
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = () => {
    const cookies = new Map();
    return {
      cookies,
      async request(url, options = {}) {
        const response = await fetch(base + url, { redirect: 'manual', ...options, headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } });
        for (const cookie of response.headers.raw()['set-cookie'] || []) {
          const part = cookie.split(';')[0];
          const at = part.indexOf('=');
          cookies.set(part.slice(0, at), part.slice(at + 1));
        }
        return response;
      },
    };
  };
  return { dir, config, browser, base };
}
function multipart(files = [{ buffer: PNG, filename: 'photo.png', type: 'image/png' }], name = 'Same Name') {
  const form = new FormData();
  for (const file of files) form.append('photos', file.buffer, { filename: file.filename, contentType: file.type });
  if (name !== null) form.append('uploaderName', name);
  return { method: 'POST', body: form, headers: form.getHeaders() };
}
const postJSON = data => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
async function filesUnder(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(file)); else result.push(file);
  }
  return result;
}

test('serves both pages and assets without exposing repository files', async t => {
  const { browser } = await setup(t);
  const client = browser();
  for (const url of ['/', '/album', '/album.html', '/app.js', '/album.js', '/client.js', '/styles.css', '/auth.js']) assert.equal((await client.request(url)).status, 200, url);
  const login = await client.request('/login');
  assert.equal(login.status, 302);
  assert.equal(new URL(login.headers.get('location')).pathname, '/');
  for (const url of ['/server/index.js', '/package.json', '/.env', '/.git/config', '/server/uploads/originals/a']) assert.equal((await client.request(url)).status, 404, url);
  const html = await (await client.request('/')).text();
  assert.ok(!html.includes('duckdns'));
  assert.equal((await client.request('/health')).status, 200);
});
test('accepts real signatures, chooses a safe extension, sets both cookies, and hides metadata', async t => {
  const { config, browser } = await setup(t);
  const client = browser();
  const response = await client.request('/upload', multipart([{ buffer: PNG, filename: '../../evil.html', type: 'image/png' }], 'A'.repeat(90)));
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.raw()['set-cookie'].length, 2);
  const result = await response.json();
  const item = result.files[0];
  assert.match(item.fileName, /^\d+_[a-f0-9]{32}\.png$/);
  assert.equal(item.uploaderName.length, 60);
  assert.equal(item.savedAt, undefined);
  assert.equal(item.deviceId, undefined);
  const media = await client.request(item.servedPath);
  assert.equal(media.status, 200);
  assert.match(media.headers.get('content-type'), /^image\/png/);
  assert.deepEqual(await media.buffer(), PNG);
  assert.equal((await client.request(item.servedPath + '.meta.json')).status, 404);
  const gallery = await (await client.request('/api/gallery')).json();
  assert.equal(gallery.items.length, 1);
  assert.equal(gallery.items[0].deviceId, undefined);
  assert.equal(gallery.items[0].mine, true);
  assert.equal((await filesUnder(config.incomingDir)).length, 0);
});
test('rejects disguised files and rolls back the entire batch', async t => {
  const { config, browser } = await setup(t);
  const response = await browser().request('/upload', multipart([
    { buffer: PNG, filename: 'real.png', type: 'image/png' },
    { buffer: Buffer.from('<script>bad</script>'), filename: 'fake.png', type: 'image/png' },
  ]));
  assert.equal(response.status, 415);
  assert.deepEqual(await filesUnder(config.originalsDir), []);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
});
test('rejects unsupported types, empty submissions, and too many files', async t => {
  const { config, browser } = await setup(t, { MAX_FILES: '1' });
  const client = browser();
  assert.equal((await client.request('/upload', multipart([{ buffer: PNG, filename: 'x.svg', type: 'image/svg+xml' }]))).status, 415);
  assert.equal((await client.request('/upload', multipart([]))).status, 400);
  assert.equal((await client.request('/upload', multipart(Array.from({ length: 2 }, () => ({ buffer: PNG, filename: 'x.png', type: 'image/png' }))))).status, 400);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
});
test('enforces streamed batch size and releases reservations after rejection', async t => {
  const { config, browser } = await setup(t, { MAX_TOTAL_BYTES: String(PNG.length + 1) });
  const client = browser();
  assert.equal((await client.request('/upload', multipart(Array.from({ length: 2 }, () => ({ buffer: PNG, filename: 'x.png', type: 'image/png' }))))).status, 413);
  assert.equal((await client.request('/upload', multipart())).status, 200);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
});
test('enforces storage quota and does not leak failed upload reservations', async t => {
  const { config, browser } = await setup(t, { MAX_STORAGE_BYTES: String(PNG.length + 1) });
  const client = browser();
  const oversized = Buffer.concat([PNG, Buffer.alloc(PNG.length)]);
  assert.equal((await client.request('/upload', multipart([{ buffer: oversized, filename: 'x.png', type: 'image/png' }]))).status, 507);
  assert.equal((await client.request('/upload', multipart())).status, 200);
  assert.equal((await client.request('/upload', multipart())).status, 507);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
});
test('rolls back moved files when metadata writing fails', async t => {
  let calls = 0;
  const { config, browser } = await setup(t, {}, { writeMetadata: async (...args) => {
    if (++calls === 2) throw new Error('Simulated metadata write failure');
    return fs.writeFile(...args);
  } });
  const response = await browser().request('/upload', multipart(Array.from({ length: 2 }, () => ({ buffer: PNG, filename: 'x.png', type: 'image/png' }))));
  assert.equal(response.status, 500);
  assert.deepEqual(await filesUnder(config.originalsDir), []);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
});
test('invalid, malformed, and traversal cookies are replaced safely', async t => {
  const { config, browser } = await setup(t);
  const client = browser();
  assert.equal((await client.request('/api/recent', { headers: { cookie: 'wedding_device=%ZZ; wedding_guest_name=%ZZ' } })).status, 200);
  const options = multipart();
  options.headers.cookie = 'wedding_device=x%2F..%2F..%2F..%2Fescaped';
  const uploaded = await client.request('/upload', options);
  assert.equal(uploaded.status, 200);
  assert.ok((await filesUnder(config.originalsDir)).every(file => file.startsWith(config.originalsDir + path.sep)));
  assert.equal((await fs.readdir(config.uploadsRoot)).includes('escaped.png'), false);
});
test('mine identifies the signed browser session, not a shared name', async t => {
  const { browser } = await setup(t);
  const first = browser(), second = browser();
  assert.equal((await first.request('/upload', multipart())).status, 200);
  assert.equal((await second.request('/upload', multipart())).status, 200);
  for (const client of [first, second]) {
    const mine = await (await client.request('/api/gallery?mine=true')).json();
    assert.equal(mine.total, 1);
    assert.equal(mine.items[0].mine, true);
    assert.equal((await (await client.request('/api/gallery')).json()).total, 2);
  }
  const signed = first.cookies.get('wedding_device');
  first.cookies.set('wedding_device', signed.slice(0, -1) + (signed.endsWith('0') ? '1' : '0'));
  assert.equal((await (await first.request('/api/gallery?mine=true')).json()).total, 0);
});
test('sorts all disk photos before limiting and supports old names and pagination', async t => {
  const { config, browser } = await setup(t);
  const directory = path.join(config.originalsDir, config.eventSlug, '2026-02-05');
  await fs.mkdir(directory, { recursive: true });
  for (let index = 0; index < 25; index++) {
    const file = path.join(directory, `photo-${String(index).padStart(2, '0')}.png`);
    await fs.writeFile(file, PNG);
    await fs.writeFile(file + '.meta.json', JSON.stringify({ uploadedAt: index + 1 }));
  }
  await fs.writeFile(path.join(directory, 'legacy.png_91dcec99ab9d'), PNG);
  const client = browser();
  const recent = await (await client.request('/api/recent')).json();
  assert.equal(recent.items.length, 20);
  assert.ok(recent.items.some(item => item.url.endsWith('photo-24.png')));
  const page = await (await client.request('/api/gallery?limit=5&offset=20')).json();
  assert.equal(page.items.length, 5);
  assert.equal(page.total, 26);
  const all = await scanGallery(config);
  const legacy = all.find(item => item.url.includes('legacy.png_'));
  assert.ok(legacy);
  assert.equal((await client.request(legacy.url)).status, 200);
});
test('reads legacy roots without copying or modifying their photos', async t => {
  const { config, dir } = await setup(t);
  const legacy = path.join(dir, 'legacy', 'originals');
  const day = path.join(legacy, config.eventSlug, '2026-02-05');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(path.join(day, 'photo.png_91dcec99ab9d'), PNG);
  config.originalsRoots.push(legacy);
  assert.equal((await scanGallery(config)).length, 1);
  assert.deepEqual(await fs.readFile(path.join(day, 'photo.png_91dcec99ab9d')), PNG);
});
test('access code protects APIs, pages, uploads, and media', async t => {
  const { browser } = await setup(t, { ACCESS_CODE: 'a-long-wedding-code' });
  const client = browser();
  assert.equal((await client.request('/')).status, 302);
  for (const route of ['/api/gallery', '/api/recent', '/media/0/main-event/2026-02-05/x.png']) assert.equal((await client.request(route)).status, 401);
  assert.equal((await client.request('/upload', multipart())).status, 401);
  assert.equal((await client.request('/session/access', postJSON({ code: 'incorrect' }))).status, 401);
  assert.equal((await client.request('/session/access', postJSON({ code: 'a-long-wedding-code' }))).status, 200);
  assert.equal((await client.request('/')).status, 200);
  assert.equal((await client.request('/upload', multipart())).status, 200);
  const item = (await (await client.request('/api/recent')).json()).items[0];
  assert.equal((await client.request(item.url)).status, 200);
  assert.equal((await browser().request(item.url)).status, 401);
});
test('blocks cross-origin writes and rate limits repeated uploads and logins', async t => {
  const { browser } = await setup(t, { UPLOAD_RATE_LIMIT: '1', LOGIN_RATE_LIMIT: '1' });
  const client = browser();
  const options = multipart();
  options.headers.origin = 'https://unrelated.example';
  assert.equal((await client.request('/upload', options)).status, 403);
  assert.equal((await client.request('/upload', multipart())).status, 200);
  const limited = await client.request('/upload', multipart());
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  // Successful code entry must not lock out other guests sharing the same Wi-Fi.
  assert.equal((await client.request('/session/access', postJSON({ code: '' }))).status, 200);
  assert.equal((await client.request('/session/access', postJSON({ code: '' }))).status, 200);
});
test('blocks symlinks and private files in media routes', async t => {
  const { config, browser, dir } = await setup(t);
  const day = path.join(config.originalsDir, config.eventSlug, '2026-02-05');
  await fs.mkdir(day, { recursive: true });
  const privateFile = path.join(dir, 'private.png');
  await fs.writeFile(privateFile, PNG);
  await fs.symlink(privateFile, path.join(day, 'link.png'));
  const client = browser();
  for (const name of ['link.png', 'x.png.meta.json', '..%2F..%2Fprivate.png']) assert.equal((await client.request(`/media/0/${config.eventSlug}/2026-02-05/${name}`)).status, 404);
});
test('validates deployment configuration and publishes actual upload limits', async t => {
  assert.equal(createConfig({ NODE_ENV: 'production' }).accessCode, '');
  assert.throws(() => createConfig({ NODE_ENV: 'production', ACCESS_CODE: 'too-short' }), /ACCESS_CODE/);
  assert.throws(() => createConfig({ EVENT_SLUG: '../../bad' }), /EVENT_SLUG/);
  assert.throws(() => createConfig({ MAX_FILES: 'NaN' }), /MAX_FILES/);
  const { browser } = await setup(t, { MAX_FILES: '2', MAX_TOTAL_BYTES: '1234' });
  const settings = await (await browser().request('/api/config')).json();
  assert.equal(settings.maxFiles, 2);
  assert.equal(settings.maxTotalBytes, 1234);
});

test('accepts the exact maximum file count, including a single-file configuration', async t => {
  for (const max of [1, 5]) {
    const { browser } = await setup(t, { MAX_FILES: String(max) });
    const response = await browser().request('/upload', multipart(Array.from({ length: max }, () => ({ buffer: PNG, filename: 'x.png', type: 'image/png' }))));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).files.length, max);
  }
});
test('signed browser identity survives an application restart', async t => {
  const { config, browser } = await setup(t);
  const client = browser();
  assert.equal((await client.request('/upload', multipart())).status, 200);
  const app = await createApp(config);
  const second = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(async () => { second.closeAllConnections(); await new Promise(resolve => second.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${second.address().port}/api/gallery?mine=true`, { headers: { cookie: [...client.cookies].map(([key, value]) => `${key}=${value}`).join('; ') } });
  assert.equal((await response.json()).total, 1);
});
test('accepts exactly the byte limit and verifies photos when a phone omits MIME', async t => {
  const { browser } = await setup(t, { MAX_TOTAL_BYTES: String(PNG.length) });
  assert.equal((await browser().request('/upload', multipart([{ buffer: PNG, filename: 'photo', type: 'application/octet-stream' }]))).status, 200);
});
test('saves a valid MP4 without adding it to the photo album', async t => {
  const { browser } = await setup(t);
  const client = browser();
  const video = await fs.readFile(path.join(__dirname, 'fixtures', 'clip.mp4'));
  const response = await client.request('/upload', multipart([{ buffer: video, filename: 'clip.mp4', type: 'video/mp4' }]));
  assert.equal(response.status, 200, await response.clone().text());
  const uploaded = (await response.json()).files[0];
  assert.equal(uploaded.mimetype, 'video/mp4');
  assert.equal((await client.request(uploaded.servedPath)).status, 200);
  assert.equal((await (await client.request('/api/gallery')).json()).total, 0);
});
test('limits failed code attempts while allowing successful guests', async t => {
  const { browser } = await setup(t, { ACCESS_CODE: 'test-wedding-code', LOGIN_RATE_LIMIT: '1' });
  const client = browser();
  assert.equal((await client.request('/session/access', postJSON({ code: 'test-wedding-code' }))).status, 200);
  assert.equal((await client.request('/session/access', postJSON({ code: 'wrong' }))).status, 401);
  assert.equal((await client.request('/session/access', postJSON({ code: 'wrong' }))).status, 429);
});
test('concurrent upload requests respect quota and recover cleanly', async t => {
  const { config, browser } = await setup(t, { MAX_STORAGE_BYTES: String(PNG.length) });
  const responses = await Promise.all(Array.from({ length: 3 }, () => browser().request('/upload', multipart())));
  const statuses = responses.map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 507, 507]);
  assert.deepEqual(await filesUnder(config.incomingDir), []);
  assert.equal((await filesUnder(config.originalsDir)).filter(file => !file.endsWith('.meta.json')).length, 1);
});
test('load test script uploads actual PNG and MP4 fixtures to a local test server', async t => {
  const { base } = await setup(t);
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const result = await promisify(execFile)(process.execPath, [path.join(__dirname, '..', 'scripts/stress.js')], {
    env: { ...process.env, BASE_URL: base, STRESS_UPLOADS: '4', STRESS_BROWSE: '12', STRESS_CONCURRENCY: '2', STRESS_VIDEO: path.join(__dirname, 'fixtures', 'clip.mp4'), STRESS_VIDEO_RATIO: '0.5', ACCESS_CODE: '' },
  });
  assert.match(result.stdout, /uploads: 4\/4 succeeded/);
  assert.match(result.stdout, /browse: 12\/12 succeeded/);
});
test('wedding guests can open pages, upload, and view photos without a code in production', async t => {
  const { browser } = await setup(t, { NODE_ENV: 'production', ACCESS_CODE: '', SECURE_COOKIES: 'false' });
  const client = browser();
  const settings = await (await client.request('/api/config')).json();
  assert.equal(settings.accessRequired, false);
  for (const route of ['/', '/album', '/api/gallery']) assert.equal((await client.request(route)).status, 200);
  const login = await client.request('/login');
  assert.equal(login.status, 302);
  assert.equal(new URL(login.headers.get('location')).pathname, '/');
  const response = await client.request('/upload', multipart());
  assert.equal(response.status, 200);
  const uploaded = (await response.json()).files[0];
  const freshGuest = browser();
  assert.equal((await freshGuest.request(uploaded.servedPath)).status, 200);
  assert.equal((await freshGuest.request(uploaded.servedPath + '.meta.json')).status, 404);
});

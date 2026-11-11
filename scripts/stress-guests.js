#!/usr/bin/env node
// A local-only mixed workload. Never connects to the running wedding server.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { deflateSync } = require('node:zlib');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { setTimeout: sleep } = require('node:timers/promises');

function integer(key, fallback, min = 1) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${key} must be an integer >= ${min}`);
  return value;
}
function distribution(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => +sorted[Math.ceil(q * sorted.length) - 1].toFixed(2);
  return { count: values.length, average: +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(2), p50: at(.5), p95: at(.95), p99: at(.99), max: +sorted.at(-1).toFixed(2) };
}
async function pool(items, concurrency, run) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) await run(items[cursor++]);
  }));
}
function pngFixture(side) {
  // A decodable RGB PNG with incompressible pixels, rather than a tiny signature stub.
  function chunk(type, data) {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
    return result;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 2;
  const pixels = randomBytes(side * (1 + side * 3));
  for (let row = 0; row < side; row++) pixels[row * (1 + side * 3)] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
async function worker() {
  const { createConfig } = require('../server/config');
  const { createApp } = require('../server');
  const config = createConfig({ ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: '0',
    PHOTO_STORAGE_ROOT: process.env.WEDDING_STRESS_STORAGE, LEGACY_STORAGE_ROOTS: '', ACCESS_CODE: '', ADMIN_CODE_HASH: '',
    SESSION_SECRET: randomBytes(32).toString('hex'), SECURE_COOKIES: 'false', TRUST_PROXY: 'loopback',
    CORS_ORIGINS: 'https://agostonicholas.github.io' });
  const app = await createApp(config);
  const server = app.listen(0, '127.0.0.1');
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let previous = process.cpuUsage();
  let previousTime = performance.now();
  process.on('message', message => {
    if (message === 'sample') {
      const now = performance.now();
      const cpu = process.cpuUsage();
      process.send({ type: 'sample', memory: process.memoryUsage(), cpuPercent: ((cpu.user - previous.user) + (cpu.system - previous.system)) / ((now - previousTime) * 10),
        eventLoopP99Ms: delay.percentile(99) / 1e6, eventLoopMaxMs: delay.max / 1e6 });
      previous = cpu; previousTime = now; delay.reset();
    }
    if (message === 'stop') {
      delay.disable(); server.closeAllConnections(); server.close(() => process.exit(0));
    }
  });
  server.once('listening', () => process.send({ type: 'ready', port: server.address().port, uploadRateLimit: config.uploadRateLimit, maxFiles: config.maxFiles, maxTotalBytes: config.maxTotalBytes }));
}

async function main() {
  const guests = integer('STRESS_GUESTS', 50);
  const seedCount = integer('STRESS_SEED_PHOTOS', 300);
  const side = integer('STRESS_IMAGE_SIDE', 1024);
  const durations = [integer('STRESS_IDLE_SECONDS', 60), integer('STRESS_MIXED_SECONDS', 120), integer('STRESS_BURST_SECONDS', 30), integer('STRESS_RECOVERY_SECONDS', 30)];
  const output = path.resolve(process.env.STRESS_REPORT_DIR || path.join('.runtime', 'stress', new Date().toISOString().replace(/[:.]/g, '-')));
  await fs.mkdir(output, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wedding-guests-'));
  const storage = path.join(temporary, 'photos');
  const day = path.join(storage, 'originals', 'main-event', '2026-01-01');
  const fixture = pngFixture(side);
  const fixturePath = path.join(temporary, 'fixture.png');
  const expectedHash = createHash('sha256').update(fixture).digest('hex');
  await fs.mkdir(day, { recursive: true });
  await fs.writeFile(fixturePath, fixture);
  await pool(Array.from({ length: seedCount }, (_, i) => i), 16, async i => {
    const file = path.join(day, `seed-${String(i).padStart(5, '0')}.png`);
    await fs.link(fixturePath, file);
    await fs.writeFile(file + '.meta.json', JSON.stringify({ uploaderName: 'Seed guest', uploadedAt: Date.UTC(2026, 0, 1) + i }));
  });
  const log = await fs.open(path.join(output, 'server.log'), 'w');
  const child = fork(__filename, ['--worker'], { env: { ...process.env, WEDDING_STRESS_STORAGE: storage }, stdio: ['ignore', log.fd, log.fd, 'ipc'] });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const resources = [];
  let sampler;
  let phaseName = 'startup';
  child.on('message', message => { if (message.type === 'sample') resources.push({ phase: phaseName, ...message }); });
  try {
    const ready = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Local server startup timed out')), 30000);
      child.on('message', message => { if (message.type === 'ready') { clearTimeout(timeout); resolve(message); } });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Local server exited: ${code}`)); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
    });
    const base = `http://127.0.0.1:${ready.port}`;
    sampler = setInterval(() => { if (child.connected) child.send('sample'); }, 1000);
    const records = [];
    const failures = [];
    const groups = {};
    const uploads = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const clients = Array.from({ length: guests }, (_, index) => ({ index, token: '', cache: new Set(), recent: '', roles: [], batches: 0, uploaded: 0 }));
    async function request(client, endpoint, { kind = 'api', method = 'GET', body, json = true, headers = {} } = {}) {
      const phase = phaseName;
      const started = performance.now();
      inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
      let bytes = 0;
      let status = 0;
      try {
        if (client.token && kind !== 'media' && kind !== 'asset') await preflight(client, endpoint, method);
        const response = await fetch(base + endpoint, { method, body, signal: AbortSignal.timeout(120000), headers: {
          Origin: 'https://agostonicholas.github.io', ...(client.token && kind !== 'media' && kind !== 'asset' ? { 'X-Wedding-Device': client.token } : {}), ...headers,
        } });
        status = response.status;
        if (kind !== 'media' && kind !== 'asset') client.token = response.headers.get('x-wedding-device') || client.token;
        if (response.headers.get('access-control-allow-origin') !== 'https://agostonicholas.github.io') throw new Error('Missing permitted frontend origin');
        let value;
        if (json) { const text = await response.text(); bytes = Buffer.byteLength(text); value = JSON.parse(text); }
        else if (response.body) { for await (const chunk of response.body) bytes += chunk.length; }
        if (!response.ok || (json && !value.ok)) throw new Error(`HTTP ${response.status}: ${value?.error || endpoint}`);
        return json ? value : true;
      } catch (error) {
        failures.push({ phase, guest: client.index, endpoint, status, message: error.message });
        return null;
      } finally {
        inFlight--;
        records.push({ phase, kind, ms: performance.now() - started, bytes, status });
      }
    }
    async function preflight(client, endpoint, method) {
      const started = performance.now();
      let status = 0;
      try {
        const response = await fetch(base + endpoint, { method: 'OPTIONS', signal: AbortSignal.timeout(30000), headers: {
          Origin: 'https://agostonicholas.github.io', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'x-wedding-device',
        } });
        status = response.status;
        await response.arrayBuffer();
        if (status !== 204 || response.headers.get('access-control-allow-origin') !== 'https://agostonicholas.github.io' ||
          !response.headers.get('access-control-allow-headers')?.toLowerCase().includes('x-wedding-device') ||
          !response.headers.get('access-control-allow-methods')?.split(',').includes(method)) throw new Error(`Preflight failed for ${endpoint}`);
      } finally { records.push({ phase: phaseName, kind: 'preflight', ms: performance.now() - started, bytes: 0, status }); }
    }
    async function images(client, items) {
      await pool(items.filter(item => !client.cache.has(item.url)), 6, async item => {
        const received = await request(client, item.url, { kind: 'media', json: false });
        // Browser-style one-hour private media cache, scoped to each guest.
        if (received) client.cache.add(item.url);
      });
    }
    async function recent(client) {
      const value = await request(client, '/api/recent', { kind: 'recent' });
      if (!value) return;
      const signature = value.items.map(item => item.url).join('|');
      if (signature !== client.recent) { client.recent = signature; await images(client, value.items); }
    }
    async function album(client, mine = false, offset = 0) {
      const value = await request(client, `/api/gallery?limit=300&offset=${offset}${mine ? '&mine=true' : ''}`, { kind: mine ? 'gallery-mine' : 'gallery' });
      // Approximate lazy-loaded images in/near the viewport while scrolling.
      if (value) await images(client, value.items.slice(0, 12));
    }
    async function upload(client) {
      const form = new FormData();
      for (let i = 0; i < 3; i++) form.append('photos', new Blob([fixture], { type: 'image/png' }), `guest-${client.index}-batch-${client.batches}-${i}.png`);
      form.append('uploaderName', `Load Guest ${client.index}`);
      client.batches++;
      const value = await request(client, '/upload', { kind: 'upload', method: 'POST', body: form });
      if (value) {
        uploads.push(...value.files);
        client.uploaded += value.files.length;
        if (value.files.length !== 3) failures.push({ phase: phaseName, guest: client.index, message: 'Incomplete successful upload batch' });
      }
    }
    async function phase(name, seconds, run) {
      phaseName = name;
      const start = performance.now();
      const before = records.length;
      console.log(`[guests] ${name}: ${guests} guests, ${seconds}s`);
      await Promise.all(clients.map(client => run(client, start, start + seconds * 1000)));
      const samples = records.slice(before);
      groups[name] = { wallSeconds: +((performance.now() - start) / 1000).toFixed(2), requests: samples.length,
        bytesReceived: samples.reduce((sum, value) => sum + value.bytes, 0), latencyMs: distribution(samples.map(value => value.ms)) };
      console.log(`[guests] ${name}: ${samples.length} requests, p95 ${groups[name].latencyMs.p95}ms, failures so far ${failures.length}`);
    }
    async function ticks(start, until, interval, action) {
      for (let tick = 0; start + tick * interval < until; tick++) {
        await sleep(Math.max(0, start + tick * interval - performance.now()));
        if (performance.now() >= until) break;
        await action(tick);
      }
      await sleep(Math.max(0, until - performance.now()));
    }
    console.log(`[guests] Local server ${base}; ${seedCount} seeded images; ${(fixture.length / 1024 ** 2).toFixed(2)} MiB per image. Reports: ${output}`);
    await phase('idle-slideshow', durations[0], async (client, start, until) => {
      await request(client, '/api/config', { kind: 'config' });
      await pool(['/', '/styles.css', '/intro.js', '/logo.png', '/logo_large.png', '/site-config.js', '/client.js', '/app.js'], 6,
        endpoint => request(client, endpoint, { kind: 'asset', json: false }));
      await ticks(start, until, 10000, () => Promise.all([request(client, '/api/config', { kind: 'config' }), recent(client)]));
    });
    await phase('mixed-guests', durations[1], async (client, start, until) => {
      const role = client.index < Math.floor(guests * .5) ? 'idle' : client.index < Math.floor(guests * .8) ? 'album' : 'uploader';
      client.roles.push(role);
      if (role === 'album') {
        await request(client, '/album', { kind: 'asset', json: false });
        await ticks(start, until, 10000, async tick => {
          await album(client);
          if (tick % 3 === 1) await album(client, true);
          if (tick % 3 === 2) await album(client, false, 300);
        });
      } else {
        await ticks(start, until, 10000, async tick => {
          await Promise.all([request(client, '/api/config', { kind: 'config' }), recent(client),
            ...(role === 'uploader' && tick % 4 === 0 ? [upload(client)] : [])]);
          if (role === 'uploader' && tick % 4 === 0) await recent(client);
        });
      }
    });
    await phase('all-upload-burst', durations[2], async (client, start, until) => {
      await Promise.all([upload(client), request(client, '/api/config', { kind: 'config' }), recent(client)]);
      await recent(client);
      await ticks(start + 10000, until, 10000, () => Promise.all([request(client, '/api/config', { kind: 'config' }), recent(client)]));
    });
    await phase('recovery', durations[3], async (client, start, until) => {
      await ticks(start, until, 10000, () => Promise.all([request(client, '/api/config', { kind: 'config' }), recent(client)]));
    });
    phaseName = 'verification';
    const final = await request(clients[0], '/api/gallery?limit=1000', { kind: 'verification' });
    const unique = new Set(uploads.map(item => item.servedPath));
    const integrity = { expectedPhotos: seedCount + uploads.length, galleryPhotos: final?.total, uploadedPhotos: uploads.length,
      uniqueUploadedPaths: unique.size, metadataFiles: 0, hashesVerified: 0, identitiesVerified: 0, incompleteFiles: await fs.readdir(path.join(storage, 'incoming')) };
    await pool(clients, 10, async client => {
      const mine = await request(client, '/api/gallery?limit=1000&mine=true', { kind: 'verification' });
      if (mine?.total === client.uploaded && mine.items.every(item => item.mine && item.uploaderName === `Load Guest ${client.index}`)) integrity.identitiesVerified++;
    });
    for (const item of uploads) {
      const file = path.join(storage, 'originals', ...item.servedPath.split('/').slice(3));
      const [data, meta] = await Promise.all([fs.readFile(file), fs.readFile(file + '.meta.json', 'utf8')]);
      if (createHash('sha256').update(data).digest('hex') === expectedHash) integrity.hashesVerified++;
      if (JSON.parse(meta).uploaderName === item.uploaderName) integrity.metadataFiles++;
    }
    integrity.ok = integrity.galleryPhotos === integrity.expectedPhotos && unique.size === uploads.length && integrity.metadataFiles === uploads.length && integrity.hashesVerified === uploads.length && integrity.identitiesVerified === guests && integrity.incompleteFiles.length === 0;
    const types = {};
    for (const kind of new Set(records.map(value => value.kind))) {
      const values = records.filter(value => value.kind === kind);
      types[kind] = { latencyMs: distribution(values.map(value => value.ms)), bytesReceived: values.reduce((sum, value) => sum + value.bytes, 0),
        statuses: values.reduce((counts, value) => { counts[value.status] = (counts[value.status] || 0) + 1; return counts; }, {}) };
    }
    const report = { date: new Date().toISOString(), node: process.version, machine: { platform: process.platform, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, totalMemoryBytes: os.totalmem() },
      setup: { guests, seedPhotos: seedCount, imageBytes: fixture.length, uploadBatchFiles: 3, durations, uploadRateLimit: ready.uploadRateLimit,
        maxFiles: ready.maxFiles, maxTotalBytes: ready.maxTotalBytes, pollSeconds: 10, mediaConcurrencyPerGuest: 6, mixedRoles: clients.reduce((counts, client) => { counts[client.roles[0]] = (counts[client.roles[0]] || 0) + 1; return counts; }, {}) },
      phases: groups, types, requests: records.length, peakInFlight, failures, integrity,
      resources: { samples: resources, peakRssBytes: Math.max(0, ...resources.map(value => value.memory.rss)), peakCpuPercent: Math.max(0, ...resources.map(value => value.cpuPercent)),
        peakEventLoopP99Ms: Math.max(0, ...resources.map(value => value.eventLoopP99Ms)) },
      limits: ['Loopback HTTP, no router/WAN/TLS measurement', 'Synthetic valid PNGs; no browser rendering or video decoding',
        'Media seeded with hard links; working set can be filesystem-cached', 'Browser cache and lazy loading modeled per guest; six concurrent image fetches',
        'Every signed API request includes an uncached CORS preflight (conservative versus browser preflight caching)',
        'Clients and server share the same machine; CPU percentages are relative to one logical core', 'All guests share the loopback IP; production upload rate limit retained'] };
    report.ok = failures.length === 0 && integrity.ok;
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    const rows = Object.entries(types).map(([kind, value]) => `| ${kind} | ${value.latencyMs.count} | ${value.latencyMs.p95} | ${value.latencyMs.max} | ${(value.bytesReceived / 1024 ** 2).toFixed(1)} |`).join('\n');
    await fs.writeFile(path.join(output, 'report.md'), `# ${guests}-guest local load test\n\n${report.ok ? 'PASS' : 'FAIL'} — ${records.length} requests, ${failures.length} errors.\n\n` +
      `Seeded ${seedCount} images of ${(fixture.length / 1024 ** 2).toFixed(2)} MiB; uploads contain three images per batch.\n\n` +
      `| Request | Count | p95 ms | Max ms | Received MiB |\n| --- | ---: | ---: | ---: | ---: |\n${rows}\n\n` +
      `Server peak RSS: ${(report.resources.peakRssBytes / 1024 ** 2).toFixed(1)} MiB. Peak sampled CPU: ${report.resources.peakCpuPercent.toFixed(1)}% of one logical core. Peak sampled event-loop p99: ${report.resources.peakEventLoopP99Ms.toFixed(1)} ms.\n\n` +
      `${integrity.hashesVerified}/${uploads.length} uploaded files passed SHA-256 verification. Gallery total: ${integrity.galleryPhotos}; expected ${integrity.expectedPhotos}. Temporary incomplete files: ${integrity.incompleteFiles.length}.\n\n` +
      `Phases: ${Object.entries(groups).map(([name, value]) => `${name} ${value.wallSeconds}s`).join('; ')}.\n\n` + report.limits.map(value => `- ${value}`).join('\n') + '\n');
    console.log(`[guests] ${report.ok ? 'PASS' : 'FAIL'}: ${records.length} requests, ${failures.length} errors; ${integrity.hashesVerified} uploaded photos verified. Report: ${path.join(output, 'report.md')}`);
    if (!report.ok) process.exitCode = 1;
  } finally {
    clearInterval(sampler);
    if (child.connected) child.send('stop');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(deadline);
    await log.close();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
(process.argv.includes('--worker') ? worker() : main()).catch(error => { console.error(error); process.exitCode = 1; });

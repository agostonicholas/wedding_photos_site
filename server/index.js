const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { networkInterfaces } = require('os');
const { randomBytes, createHmac, timingSafeEqual } = require('crypto');
const { Transform, pipeline } = require('stream');
const express = require('express');
const multer = require('multer');
const morgan = require('morgan');
const cors = require('cors');
const { createConfig } = require('./config');
const { mediaType, detectFile, scanGallery, directoryBytes } = require('./media');
const DEVICE_COOKIE = 'wedding_device';
const NAME_COOKIE = 'wedding_guest_name';
const ACCESS_COOKIE = 'wedding_access';
const normalizeName = value => typeof value === 'string' ? value.trim().slice(0, 60) : '';
const httpError = (status, message) => Object.assign(new Error(message), { status });
const remove = file => fsp.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    try { cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1)); }
    catch { /* Ignore malformed cookies rather than breaking the request. */ }
  }
  return cookies;
}
async function createApp(config = createConfig(), dependencies = {}) {
  await Promise.all([config.incomingDir, config.originalsDir].map(dir => fsp.mkdir(dir, { recursive: true })));
  let secret = config.sessionSecret;
  if (!secret) {
    const secretPath = path.join(config.uploadsRoot, '.session-secret');
    try { await fsp.writeFile(secretPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    secret = await fsp.readFile(secretPath, 'utf8');
  }
  if (secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const encodeToken = value => `${value}.${sign(value)}`;
  const decodeToken = value => {
    if (typeof value !== 'string') return null;
    const separator = value.lastIndexOf('.');
    const data = value.slice(0, separator);
    return separator > 0 && equal(value.slice(separator + 1), sign(data)) ? data : null;
  };
  const accessScope = sign(`access:${config.accessCode}`);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  if (config.logRequests) app.use(morgan('tiny'));
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' blob: data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    next();
  });
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}` && !config.corsOrigins.includes(origin)) return res.status(403).json({ ok: false, error: 'This origin is not allowed.' });
    next();
  });
  app.use(cors({ origin: config.corsOrigins, credentials: true, exposedHeaders: ['X-Wedding-Device'] }));
  app.use(express.json({ limit: '8kb' }));
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: config.sessionTTL, path: '/' };
  app.use((req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    let device = decodeToken(req.get('X-Wedding-Device')) || decodeToken(req.cookies[DEVICE_COOKIE]);
    if (!/^[a-f0-9]{32}$/.test(device || '')) {
      device = randomBytes(16).toString('hex');
      res.cookie(DEVICE_COOKIE, encodeToken(device), cookieOptions);
    }
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}` && config.corsOrigins.includes(origin)) {
      res.set('X-Wedding-Device', encodeToken(device));
      res.set('Cache-Control', 'no-store');
    }
    req.deviceId = device;
    req.guestName = normalizeName(req.cookies[NAME_COOKIE]);
    const access = decodeToken(req.cookies[ACCESS_COOKIE])?.split(':');
    req.hasAccess = !config.accessCode || (access?.[0] === accessScope && Number(access[1]) > Date.now());
    next();
  });
  const attempts = new Map();
  const rateLimit = (kind, limit, duration) => (req, res, next) => {
    const now = Date.now();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const key = `${kind}:${req.ip}`;
    const entry = attempts.get(key) || { count: 0, until: now + duration };
    if (entry.count >= limit || (!attempts.has(key) && attempts.size >= 10000)) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please try again later.' });
    }
    entry.count++;
    attempts.set(key, entry);
    if (kind === 'login') res.once('finish', () => {
      if (res.statusCode < 400) entry.count = Math.max(0, entry.count - 1);
    });
    next();
  };
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) => res.json({ ok: true, maxFiles: config.maxFiles, maxTotalBytes: config.maxTotalBytes, allowedTypes: config.allowedTypes, accessRequired: Boolean(config.accessCode) }));
  app.post('/session/access', rateLimit('login', config.loginRateLimit, 15 * 60 * 1000), (req, res) => {
    if (config.accessCode && !equal(sign(String(req.body?.code || '')), sign(config.accessCode))) return res.status(401).json({ ok: false, error: 'That wedding access code is incorrect.' });
    res.cookie(ACCESS_COOKIE, encodeToken(`${accessScope}:${Date.now() + config.sessionTTL}`), cookieOptions);
    res.json({ ok: true });
  });
  for (const [route, file] of [['/login', 'login.html'], ['/auth.js', 'auth.js'], ['/styles.css', 'styles.css']]) app.get(route, (_req, res) => {
    if (route === '/login' && !config.accessCode) return res.redirect('/');
    res.sendFile(path.join(config.rootDir, file));
  });
  app.use((req, res, next) => {
    if (req.hasAccess) return next();
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html') || req.path === '/album')) return res.redirect('/login');
    res.status(401).json({ ok: false, error: 'Enter the wedding access code to continue.' });
  });
  app.post('/session/name', (req, res) => {
    const name = normalizeName(req.body?.name);
    if (!name) return res.status(400).json({ ok: false, error: 'Name is required.' });
    res.cookie(NAME_COOKIE, name, cookieOptions);
    res.json({ ok: true, name });
  });
  let storedBytes = await directoryBytes(config.originalsDir);
  let incomingBytes = 0;
  // Run one server process per writable storage directory.
  const reservations = new Map();
  const storage = {
    _handleFile(req, file, callback) {
      const filePath = path.join(config.incomingDir, `${randomBytes(20).toString('hex')}.uploading`);
      let size = 0;
      const counter = new Transform({ transform(chunk, _encoding, done) {
        if (req.uploadClosed) return done(httpError(400, 'Upload was interrupted.'));
        if ((req.batchBytes || 0) + chunk.length > config.maxTotalBytes) return done(httpError(413, 'Batch exceeds the upload size limit.'));
        if (storedBytes + incomingBytes + chunk.length > config.maxStorageBytes) return done(httpError(507, 'Photo storage is full. Please contact the hosts.'));
        req.batchBytes = (req.batchBytes || 0) + chunk.length;
        incomingBytes += chunk.length;
        reservations.set(req, (reservations.get(req) || 0) + chunk.length);
        size += chunk.length;
        done(null, chunk);
      } });
      const onAbort = () => counter.destroy(httpError(400, 'Upload was interrupted.'));
      req.once('aborted', onAbort);
      pipeline(file.stream.pipe(counter), fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }), async error => {
        req.off('aborted', onAbort);
        if (error) {
          file.stream.unpipe(counter);
          file.stream.resume();
          try { await remove(filePath); } catch (cleanupError) { console.error(cleanupError); }
          callback(error);
        } else callback(null, { path: filePath, size });
      });
    },
    _removeFile(_req, file, callback) { remove(file.path).then(() => callback(null), callback); },
  };
  const upload = multer({ storage,
    // Busboy's fileSize event fires at equality; the streaming counter enforces
    // the inclusive batch cap, including the exact maximum-sized valid file.
    limits: { files: config.maxFiles, fileSize: config.maxTotalBytes + 1, fields: 1, fieldSize: 240, parts: config.maxFiles + 2 },
    fileFilter: (_req, file, callback) => callback(config.allowedTypes.includes(file.mimetype) || file.mimetype === 'application/octet-stream' ? null : httpError(415, 'Unsupported photo or video type.'), true),
  }).array('photos', config.maxFiles);
  let galleryCache = null, galleryRead = null, cacheTime = 0, generation = 0;
  const invalidate = () => { generation++; galleryCache = null; };
  const gallery = async () => {
    if (galleryCache && Date.now() - cacheTime < 5000) return galleryCache;
    if (galleryRead) return galleryRead;
    const started = generation;
    galleryRead = scanGallery(config);
    try {
      const items = await galleryRead;
      if (started === generation) { galleryCache = items; cacheTime = Date.now(); }
      return items;
    } finally { galleryRead = null; }
  };
  let commitQueue = Promise.resolve();
  app.post('/upload', rateLimit('upload', config.uploadRateLimit, 10 * 60 * 1000), (req, res, next) => {
    const release = () => { req.uploadClosed = true; incomingBytes -= reservations.get(req) || 0; reservations.delete(req); };
    res.once('finish', release);
    res.once('close', release);
    upload(req, res, error => error ? next(error) : next());
  }, async (req, res, next) => {
    const files = req.files || [];
    const movedPaths = [];
    let unlock;
    try {
      if (!files.length) throw httpError(400, 'Select at least one photo or video.');
      for (const file of files) {
        const type = await detectFile(file.path);
        if (!type || !config.allowedTypes.includes(type.mime)) throw httpError(415, 'A file is not a supported photo or video.');
        file.detected = type;
      }
      const previous = commitQueue;
      commitQueue = new Promise(resolve => { unlock = resolve; });
      await previous;
      const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
      if (storedBytes + totalBytes > config.maxStorageBytes) throw httpError(507, 'Photo storage is full. Please contact the hosts.');
      if (req.uploadClosed) throw httpError(400, 'Upload was interrupted.');
      const name = normalizeName(req.body?.uploaderName) || req.guestName || 'Guest';
      const date = new Date().toISOString().slice(0, 10);
      const directory = path.join(config.originalsDir, config.eventSlug, date);
      await fsp.mkdir(directory, { recursive: true });
      const saved = [];
      for (const file of files) {
        if (req.uploadClosed) throw httpError(400, 'Upload was interrupted.');
        const filename = `${Date.now()}_${randomBytes(16).toString('hex')}.${file.detected.ext}`;
        const destination = path.resolve(directory, filename);
        if (path.dirname(destination) !== directory) throw new Error('Invalid storage destination.');
        await fsp.rename(file.path, destination);
        movedPaths.push(destination, `${destination}.meta.json`);
        const uploadedAt = Date.now();
        await (dependencies.writeMetadata || fsp.writeFile)(`${destination}.meta.json`, JSON.stringify({ uploaderName: name, deviceId: req.deviceId, uploadedAt }), { flag: 'wx', mode: 0o600 });
        saved.push({ id: `0/${date}/${filename}`, fileName: filename, size: file.size, mimetype: file.detected.mime,
          servedPath: `/media/0/${config.eventSlug}/${date}/${filename}`, uploaderName: name, uploadedAt, mine: true });
      }
      if (req.uploadClosed) throw httpError(400, 'Upload was interrupted.');
      storedBytes += totalBytes;
      res.cookie(NAME_COOKIE, name, cookieOptions);
      invalidate();
      res.json({ ok: true, files: saved, totalBytes });
    } catch (error) {
      try { await Promise.all([...files.map(file => file.path), ...movedPaths].map(remove)); }
      catch (cleanupError) { console.error('Upload cleanup failed:', cleanupError); }
      invalidate();
      next(error);
    } finally { unlock?.(); }
  });
  const publicItem = (item, req) => {
    const { deviceId, ...publicFields } = item;
    return { ...publicFields, mine: deviceId === req.deviceId };
  };
  app.get('/api/recent', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, items: (await gallery()).slice(0, 20).map(item => publicItem(item, req)) });
  });
  app.get('/api/gallery', async (req, res) => {
    const raw = req.query.limit === undefined ? 300 : Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 1000)) : 300;
    let items = await gallery();
    if (req.query.mine === 'true') items = items.filter(item => item.deviceId === req.deviceId);
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, items: items.slice(offset, offset + limit).map(item => publicItem(item, req)), total: items.length });
  });
  app.get(['/media/:source/:event/:date/:filename', '/media/:event/:date/:filename'], async (req, res, next) => {
    const { event, date, filename } = req.params;
    const source = req.params.source || '0';
    const root = /^\d+$/.test(source) && config.originalsRoots[Number(source)];
    const type = mediaType(filename);
    if (!root || event !== config.eventSlug || !/^\d{4}-\d{2}-\d{2}$/.test(date) || filename !== path.basename(filename) || !type || /[/\\]/.test(filename)) return next();
    const file = path.join(root, event, date, filename);
    try {
      const [realRoot, realFile, stats] = await Promise.all([fsp.realpath(root), fsp.realpath(file), fsp.lstat(file)]);
      if (!realFile.startsWith(realRoot + path.sep) || !stats.isFile()) return next();
      res.type(type).set('Cache-Control', 'private, max-age=3600');
      res.sendFile(realFile, error => { if (error) next(error); });
    } catch (error) { if (error.code === 'ENOENT') return next(); next(error); }
  });
  // List public assets explicitly; never expose server code, uploads, or .env.
  for (const [route, file] of [['/', 'index.html'], ['/index.html', 'index.html'], ['/album', 'album.html'], ['/album.html', 'album.html'], ['/app.js', 'app.js'], ['/album.js', 'album.js'], ['/client.js', 'client.js'], ['/site-config.js', 'site-config.js']]) {
    app.get(route, (_req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(config.rootDir, file)); });
  }
  app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy(error);
    const status = error instanceof multer.MulterError ? (error.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : (error.status || 500);
    if (status >= 500 && status !== 507) console.error(error);
    res.status(status).json({ ok: false, error: status >= 500 && status !== 507 ? 'Upload failed. Please try again.' : error.message });
  });
  return app;
}
if (require.main === module) {
  const config = createConfig();
  createApp(config).then(app => {
    const server = app.listen(config.port, config.host);
    server.once('listening', () => {
      const port = server.address().port;
      const allInterfaces = config.host === '0.0.0.0' || config.host === '::';
      const localHost = allInterfaces ? '127.0.0.1' : config.host;
      const localAddress = localHost.includes(':') ? `[${localHost}]` : localHost;
      console.log(`Wedding uploader listening on http://${localAddress}:${port}`);
      if (allInterfaces) {
        for (const address of new Set(Object.values(networkInterfaces()).flat().filter(value => value.family === 'IPv4' && !value.internal).map(value => value.address))) {
          console.log(`Network access: http://${address}:${port}`);
        }
      }
      console.log(`Photo storage: ${config.uploadsRoot}`);
    });
    server.on('error', error => {
      if (error.code === 'EADDRINUSE') {
        console.error(`Port ${config.port} is already in use on ${config.host}. Stop the existing server or choose another PORT before starting.`);
      } else {
        console.error(`Unable to start server: ${error.message}`);
      }
      process.exitCode = 1;
    });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createApp, parseCookies };

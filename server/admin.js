const fs = require('fs/promises');
const path = require('path');
const { createHash, randomBytes, timingSafeEqual } = require('crypto');
const { MESSAGES } = require('./service-status');

const ADMIN_COOKIE = 'wedding_admin';
const SESSION_TTL = 30 * 60 * 1000;
const TICKET_TTL = 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');
const matches = (left, right) => typeof left === 'string' && typeof right === 'string' && timingSafeEqual(Buffer.from(digest(left), 'hex'), Buffer.from(digest(right), 'hex'));
const isAdminName = value => typeof value === 'string' && value.startsWith('admin-');
const loopback = address => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

function installAdmin(app, config, controls) {
  const tickets = new Map();
  const sessions = new Map();
  const failures = new Map();
  let lifecyclePending = null;
  const prune = () => {
    const now = Date.now();
    for (const map of [tickets, sessions, failures]) for (const [key, value] of map) if (value.expiresAt <= now) map.delete(key);
  };
  const transport = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!req.secure && !loopback(req.ip)) return res.status(403).json({ ok: false, error: 'Admin access requires HTTPS.' });
    next();
  };
  const sameOrigin = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ ok: false, error: 'Open admin controls on the photo server itself.' });
    next();
  };
  const authenticate = (req, res, next) => {
    prune();
    const token = req.cookies[ADMIN_COOKIE];
    const session = token && sessions.get(digest(token));
    if (!session) return res.status(401).json({ ok: false, error: 'Your admin session has expired. Sign in again.' });
    req.adminSession = session;
    next();
  };
  const csrf = (req, res, next) => {
    if (!matches(req.get('X-Wedding-CSRF'), req.adminSession.csrf)) return res.status(403).json({ ok: false, error: 'Invalid admin request. Refresh and try again.' });
    next();
  };
  const limit = (req, res, next) => {
    prune();
    const value = failures.get(req.ip);
    if (value?.count >= 10 || (!value && failures.size >= 10000)) {
      res.set('Retry-After', String(Math.ceil(((value?.expiresAt || Date.now() + 900000) - Date.now()) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many admin sign-in attempts. Try again in 15 minutes.' });
    }
    next();
  };
  const login = (req, res) => {
    const code = req.body?.code ?? req.body?.name;
    const expected = config.adminCodeHash.slice('sha256:'.length);
    const actual = typeof code === 'string' ? digest(code.trim()) : '';
    if (!config.adminCodeHash || !isAdminName(code) || !matches(actual, expected)) {
      const value = failures.get(req.ip) || { count: 0, expiresAt: Date.now() + 15 * 60 * 1000 };
      value.count++;
      failures.set(req.ip, value);
      return res.status(401).json({ ok: false, error: 'That admin code is not valid.' });
    }
    failures.delete(req.ip);
    prune();
    if (tickets.size >= 256) return res.status(503).json({ ok: false, error: 'Please wait a minute before signing in again.' });
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(digest(ticket), { expiresAt: Date.now() + TICKET_TTL });
    // A fragment is not sent in requests or Referer headers. The admin page
    // exchanges this one-use ticket for its own HttpOnly cookie on the backend.
    res.json({ ok: true, admin: true, adminPath: `/admin#login=${ticket}` });
  };
  const loginHandlers = [transport, limit, login];
  app.post('/api/admin/login', ...loginHandlers);
  // This handler runs before normal name persistence, including on GitHub Pages.
  app.post('/session/name', (req, res, next) => {
    if (!isAdminName(req.body?.name)) return next();
    transport(req, res, () => limit(req, res, () => login(req, res)));
  });
  for (const [route, file] of [['/admin', 'admin.html'], ['/admin.js', 'admin.js'], ['/admin.css', 'admin.css']]) {
    app.get(route, (_req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.sendFile(path.join(config.rootDir, file));
    });
  }
  app.post('/api/admin/exchange', transport, sameOrigin, limit, (req, res) => {
    prune();
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    const key = digest(ticket);
    if (!tickets.has(key)) return res.status(401).json({ ok: false, error: 'This sign-in link has expired. Enter your admin code again.' });
    tickets.delete(key);
    if (sessions.size >= 256) return res.status(503).json({ ok: false, error: 'Too many admin sessions. Try again later.' });
    const token = randomBytes(32).toString('base64url');
    const session = { expiresAt: Date.now() + SESSION_TTL, csrf: randomBytes(32).toString('base64url') };
    sessions.set(digest(token), session);
    res.cookie(ADMIN_COOKIE, token, { httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/', maxAge: SESSION_TTL });
    res.json({ ok: true });
  });
  app.get('/api/admin/status', transport, sameOrigin, authenticate, (_req, res) => {
    res.json({ ok: true, ...controls.status(), lifecyclePending, csrf: _req.adminSession.csrf, expiresAt: _req.adminSession.expiresAt });
  });
  app.post('/api/admin/logout', transport, sameOrigin, authenticate, csrf, (req, res) => {
    sessions.delete(digest(req.cookies[ADMIN_COOKIE]));
    res.clearCookie(ADMIN_COOKIE, { path: '/', httpOnly: true, secure: req.secure, sameSite: 'strict' });
    res.json({ ok: true });
  });
  app.post('/api/admin/control', transport, sameOrigin, authenticate, csrf, async (req, res) => {
    const action = req.body?.action;
    if (action === 'pause' || action === 'resume') {
      await controls.pause(action === 'pause');
      return res.json({ ok: true, message: action === 'pause' ? MESSAGES.paused : '' });
    }
    if (!['restart', 'stop'].includes(action)) return res.status(400).json({ ok: false, error: 'Unknown admin action.' });
    if (req.body?.confirmation !== 'confirm') return res.status(400).json({ ok: false, error: 'Type confirm to continue.' });
    if (!controls.requestLifecycle) return res.status(503).json({ ok: false, error: 'Restart the app using npm start to enable server controls.' });
    if (lifecyclePending) return res.status(409).json({ ok: false, error: 'A server command is already pending.' });
    lifecyclePending = action;
    res.once('finish', () => controls.requestLifecycle(action));
    res.status(202).json({ ok: true, action, message: action === 'stop' ? MESSAGES.stopped : MESSAGES.restarting, detail: action === 'stop'
      ? 'Server stopping after active requests finish. Start it locally with npm start to bring it back.'
      : 'Server restarting after active requests finish. Sign in again when it returns.' });
  });
}

async function createUploadSwitch(root) {
  const stateFile = path.join(root, '.admin-state.json');
  let paused = false;
  try { paused = JSON.parse(await fs.readFile(stateFile, 'utf8')).uploadsPaused === true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let writes = Promise.resolve();
  return {
    get paused() { return paused; },
    set(value) {
      const operation = writes.then(async () => {
        const temp = `${stateFile}.${randomBytes(8).toString('hex')}.tmp`;
        try {
          await fs.writeFile(temp, JSON.stringify({ uploadsPaused: value }), { mode: 0o600, flag: 'wx' });
          await fs.rename(temp, stateFile);
          paused = value;
        } finally { await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      });
      writes = operation.catch(() => {});
      return operation;
    },
  };
}
module.exports = { installAdmin, createUploadSwitch, isAdminName };

const path = require('path');
require('dotenv').config({ quiet: true, path: path.resolve(__dirname, '..', '.env') });

const MIME_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'video/mp4', 'video/quicktime', 'video/3gpp'];
function integer(env, key, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  return value;
}
function createConfig(env = process.env) {
  const rootDir = path.resolve(__dirname, '..');
  const uploadsRoot = path.resolve(env.PHOTO_STORAGE_ROOT || path.join(__dirname, 'uploads'));
  const eventSlug = env.EVENT_SLUG || 'main-event';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(eventSlug)) throw new Error('EVENT_SLUG must contain only letters, numbers, hyphens, or underscores.');
  const accessCode = env.ACCESS_CODE || '';
  const adminCodeHash = env.ADMIN_CODE_HASH || '';
  if (adminCodeHash && !/^sha256:[a-f0-9]{64}$/.test(adminCodeHash)) throw new Error('Generate ADMIN_CODE_HASH with npm run admin:code.');
  if (env.NODE_ENV === 'production' && accessCode && accessCode.length < 12) throw new Error('If set, ACCESS_CODE must contain at least 12 characters in production.');
  const allowedTypes = env.ALLOWED_MIME ? env.ALLOWED_MIME.split(',').map(value => value.trim()).filter(Boolean) : MIME_TYPES;
  if (!allowedTypes.length || allowedTypes.some(type => !MIME_TYPES.includes(type))) throw new Error('ALLOWED_MIME must be a subset of supported photo and video types.');
  const legacyRoots = env.LEGACY_STORAGE_ROOTS === undefined
    ? [path.join(__dirname, 'uploads'), path.join(rootDir, '<<SET_ABSOLUTE_PHOTO_STORAGE_PATH>>')]
    : env.LEGACY_STORAGE_ROOTS.split(',').filter(Boolean).map(value => path.resolve(value.trim()));
  return {
    rootDir, uploadsRoot, incomingDir: path.join(uploadsRoot, 'incoming'), originalsDir: path.join(uploadsRoot, 'originals'),
    originalsRoots: [...new Set([uploadsRoot, ...legacyRoots])].map(root => path.join(root, 'originals')),
    port: integer(env, 'PORT', 4000, 0, 65535), host: env.HOST || '127.0.0.1', eventSlug,
    maxFiles: integer(env, 'MAX_FILES', 5, 1, 100), maxTotalBytes: integer(env, 'MAX_TOTAL_BYTES', 100 * 1024 * 1024),
    maxStorageBytes: integer(env, 'MAX_STORAGE_BYTES', 50 * 1024 ** 3), sessionTTL: integer(env, 'SESSION_TTL_MS', 7 * 24 * 60 * 60 * 1000),
    sessionSecret: env.SESSION_SECRET || '', accessCode, adminCodeHash,
    secureCookies: env.SECURE_COOKIES === 'true' || (env.SECURE_COOKIES !== 'false' && env.NODE_ENV === 'production'),
    trustProxy: env.TRUST_PROXY === 'loopback' ? 'loopback' : false,
    corsOrigins: (env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    uploadRateLimit: integer(env, 'UPLOAD_RATE_LIMIT', 300), loginRateLimit: integer(env, 'LOGIN_RATE_LIMIT', 20),
    allowedTypes, logRequests: env.NODE_ENV !== 'test',
  };
}
module.exports = { createConfig };

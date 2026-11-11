const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MESSAGES = Object.freeze({
  paused: 'We paused uploads for a bit -Nick',
  stopped: 'Service not running right now -Nick',
  restarting: 'Service is restarting -Nick',
});
const service = state => ({ state, message: MESSAGES[state] || '' });
const statusDirectory = () => process.env.WEDDING_STATUS_DIR || path.resolve(__dirname, '..', '.runtime', 'public-status');
async function storeStatus(state) {
  if (!['stopped', 'restarting'].includes(state)) throw new Error('Invalid public service status.');
  const directory = statusDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || (process.getuid && stats.uid !== process.getuid())) throw new Error('Public status directory must be owned by the server user.');
  const message = MESSAGES[state];
  const files = {
    'status.json': JSON.stringify({ ok: false, error: message, service: service(state) }),
    'status.html': `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="10"><title>Wedding Photo Drop</title><style>body{margin:0;min-height:100svh;display:grid;place-items:center;background:#12030b;color:#fff;font:1.15rem/1.7 system-ui,sans-serif;text-align:center}main{padding:2rem;max-width:28rem}p{margin:0}</style></head><body><main><p>${message}</p></main></body></html>`,
  };
  for (const [name, data] of Object.entries(files)) {
    const file = path.join(directory, name);
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o644 });
      await fs.rename(temporary, file);
    } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
}
let writes = Promise.resolve();
function writeStatus(state) {
  const operation = writes.then(() => storeStatus(state));
  writes = operation.catch(() => {});
  return operation;
}
module.exports = { MESSAGES, service, statusDirectory, writeStatus };

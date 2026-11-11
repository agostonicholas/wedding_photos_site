const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const envFile = path.resolve(__dirname, '..', '.env');
const code = `admin-${randomBytes(24).toString('base64url')}`;
const hash = `sha256:${createHash('sha256').update(code).digest('hex')}`;
const original = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
const lines = original.split('\n').filter(line => !/^\s*ADMIN_CODE_HASH\s*=/.test(line));
while (lines.at(-1) === '') lines.pop();
const temporary = `${envFile}.${randomBytes(8).toString('hex')}.tmp`;
try {
  fs.writeFileSync(temporary, lines.concat(`ADMIN_CODE_HASH=${hash}`, '').join('\n'), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, envFile);
} finally {
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log('Admin code (save privately; it is not stored in plaintext):');
console.log(code);
console.log('Restart the server after generating or changing the code.');

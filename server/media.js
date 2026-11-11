const fs = require('fs/promises');
const path = require('path');
const TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.heif': 'image/heif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.3gp': 'video/3gpp' };
// Older uploads placed the device ID after the extension. Read them in place.
function mediaType(filename) {
  return TYPES[path.extname(filename.replace(/_[a-f0-9]{12,32}$/i, '')).toLowerCase()];
}
async function detectFile(filePath) {
  const { fileTypeFromFile } = await import('file-type');
  try { return await fileTypeFromFile(filePath); }
  catch (error) { if (error.code) throw error; return undefined; }
}
async function readMetadata(filePath) {
  try { return JSON.parse(await fs.readFile(`${filePath}.meta.json`, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return {}; }
}
async function scanGallery(config) {
  const items = [];
  for (const [source, root] of config.originalsRoots.entries()) {
    const eventDir = path.join(root, config.eventSlug);
    let days;
    try {
      if (!(await fs.lstat(eventDir)).isDirectory()) continue;
      days = await fs.readdir(eventDir, { withFileTypes: true });
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const day of days) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      const dayDir = path.join(eventDir, day.name);
      const entries = await fs.readdir(dayDir, { withFileTypes: true });
      for (let index = 0; index < entries.length; index += 16) {
        await Promise.all(entries.slice(index, index + 16).map(async entry => {
          const mimetype = mediaType(entry.name);
          if (!entry.isFile() || !mimetype?.startsWith('image/')) return;
          const filePath = path.join(dayDir, entry.name);
          let stats, meta;
          try { [stats, meta] = await Promise.all([fs.stat(filePath), readMetadata(filePath)]); }
          catch (error) { if (error.code === 'ENOENT') return; throw error; }
          items.push({ id: `${source}/${day.name}/${entry.name}`, url: `/media/${source}/${config.eventSlug}/${day.name}/${encodeURIComponent(entry.name)}`,
            mimetype, size: stats.size, uploadedAt: Number.isFinite(meta.uploadedAt) ? meta.uploadedAt : stats.mtimeMs,
            uploaderName: typeof meta.uploaderName === 'string' ? meta.uploaderName.slice(0, 60) : 'Guest', deviceId: meta.deviceId });
        }));
      }
    }
  }
  return items.sort((a, b) => b.uploadedAt - a.uploadedAt || a.id.localeCompare(b.id));
}
async function directoryBytes(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  let total = 0;
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(file);
    else if (entry.isFile() && !entry.name.endsWith('.meta.json')) total += (await fs.stat(file)).size;
  }
  return total;
}
module.exports = { mediaType, detectFile, scanGallery, directoryBytes };

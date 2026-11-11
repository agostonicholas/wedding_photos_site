const { json, storage, resolveUrl, loginUrl, getDeviceToken, config: configPromise } = window.Wedding;
const form = document.getElementById('upload-form');
const fileInput = document.getElementById('photos');
const fileCount = document.getElementById('file-count');
const fileList = document.getElementById('file-list');
const statusEl = document.getElementById('status');
const uploadBtn = document.getElementById('upload-btn');
const slideshowEl = document.getElementById('slideshow');
const welcomeOverlay = document.getElementById('welcome-overlay');
const welcomeInput = document.getElementById('guest-name-input');
const welcomeError = document.getElementById('welcome-error');
let guestName = storage.get('weddingUploaderName');
let config;
let uploading = false;
let refreshing = false;
let slideItems = [];
let slideIndex = 0;
const setStatus = (state, message) => { statusEl.className = `status ${state}`; statusEl.textContent = message; };
const formatBytes = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
function renderFiles(files) {
  fileList.replaceChildren();
  for (const file of files) {
    const row = document.createElement('li');
    row.className = 'file-row';
    const name = document.createElement('strong');
    name.textContent = file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = formatBytes(file.size);
    const progress = document.createElement('progress');
    progress.max = 100;
    progress.value = 0;
    progress.setAttribute('aria-label', `Batch upload progress for ${file.name}`);
    row.append(name, meta, progress);
    fileList.append(row);
  }
}
function validate(files) {
  if (!config) return 'Waiting for the server settings.';
  if (!files.length) return 'Select at least one photo or video.';
  if (files.length > config.maxFiles) return `Choose no more than ${config.maxFiles} files at a time.`;
  if (files.reduce((sum, file) => sum + file.size, 0) > config.maxTotalBytes) return `Keep each batch at or below ${formatBytes(config.maxTotalBytes)}.`;
  // Some phones omit the MIME type; the backend always verifies file signatures.
  if (files.some(file => file.type && !config.allowedTypes.includes(file.type))) return 'One of these file types is not supported.';
  return '';
}
function updateSelection() {
  const files = Array.from(fileInput.files);
  fileCount.textContent = `${files.length} / ${config?.maxFiles || '…'} selected`;
  renderFiles(files);
  const error = validate(files);
  uploadBtn.disabled = uploading || Boolean(error);
  if (!files.length) setStatus('idle', 'Choose photos or videos to share.');
  else setStatus(error ? 'error' : 'ready', error || `${files.length} selected · ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}`);
}
function refreshName() {
  document.getElementById('hero-eyebrow').textContent = guestName || 'Guest';
  welcomeOverlay.hidden = Boolean(guestName);
  if (!guestName) welcomeInput.focus();
}
function showSlide() {
  Array.from(slideshowEl.children).forEach((image, index) => image.classList.toggle('active', index === slideIndex));
}
async function refreshSlides() {
  if (refreshing || document.hidden) return;
  refreshing = true;
  try {
    const { items } = await json('/api/recent');
    const next = items.filter(item => item.mimetype.startsWith('image/'));
    if (next.map(item => item.url).join('|') === slideItems.map(item => item.url).join('|')) return;
    const active = slideItems[slideIndex]?.url;
    slideItems = next;
    slideIndex = Math.max(0, slideItems.findIndex(item => item.url === active));
    slideshowEl.replaceChildren();
    slideshowEl.classList.toggle('is-empty', !slideItems.length);
    for (const item of slideItems) {
      const image = document.createElement('img');
      image.src = resolveUrl(item.url);
      image.alt = '';
      image.addEventListener('error', () => image.remove(), { once: true });
      slideshowEl.append(image);
    }
    showSlide();
  } catch (error) { console.warn('Slideshow refresh failed:', error.message); }
  finally { refreshing = false; }
}
function sendUpload(files) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', resolveUrl('/upload'));
    const deviceToken = getDeviceToken();
    if (deviceToken) request.setRequestHeader('X-Wedding-Device', deviceToken);
    request.timeout = 10 * 60 * 1000;
    request.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) return;
      const percent = Math.round(event.loaded / event.total * 100);
      fileList.querySelectorAll('progress').forEach(bar => { bar.value = percent; });
      setStatus('uploading', percent === 100 ? 'Saving your files…' : `Uploading batch · ${percent}%`);
    });
    request.addEventListener('load', () => {
      let payload;
      try { payload = JSON.parse(request.responseText); } catch { payload = {}; }
      if (request.status === 401) window.location.assign(loginUrl);
      if (request.status >= 200 && request.status < 300 && payload.ok) resolve(payload);
      else reject(new Error(payload.error || 'Upload failed. Your files are still selected; try again.'));
    });
    request.addEventListener('error', () => reject(new Error('Connection lost. Your files are still selected; try again.')));
    request.addEventListener('timeout', () => reject(new Error('Upload timed out. Your files are still selected; try again.')));
    const body = new FormData();
    files.forEach(file => body.append('photos', file, file.name));
    body.append('uploaderName', guestName);
    request.send(body);
  });
}
fileInput.addEventListener('change', updateSelection);
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (uploading) return;
  const files = Array.from(fileInput.files);
  const error = validate(files);
  if (error) return setStatus('error', error);
  if (!guestName) { refreshName(); return; }
  uploading = true;
  fileInput.disabled = true;
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';
  setStatus('uploading', 'Uploading your files…');
  try {
    const result = await sendUpload(files);
    fileInput.value = '';
    renderFiles([]);
    fileCount.textContent = `0 / ${config.maxFiles} selected`;
    setStatus('success', `Uploaded ${result.files.length} file${result.files.length === 1 ? '' : 's'}. Thank you!`);
    await refreshSlides();
  } catch (error) { setStatus('error', error.message); }
  finally {
    uploading = false;
    fileInput.disabled = false;
    uploadBtn.disabled = !fileInput.files.length;
    uploadBtn.textContent = fileInput.files.length ? 'Retry Upload' : 'Upload Photos';
  }
});
document.getElementById('welcome-form').addEventListener('submit', async event => {
  event.preventDefault();
  const name = welcomeInput.value.trim().slice(0, 60);
  if (!name) { welcomeError.textContent = 'Please enter your name.'; return; }
  const button = event.currentTarget.querySelector('button');
  button.disabled = true;
  try {
    const result = await json('/session/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    guestName = result.name;
    storage.set('weddingUploaderName', guestName);
    welcomeError.textContent = '';
    refreshName();
  } catch (error) { welcomeError.textContent = error.message; }
  finally { button.disabled = false; }
});
fileInput.disabled = true;
configPromise.then(value => {
  config = value;
  fileInput.disabled = false;
  fileInput.accept = config.allowedTypes.join(',');
  document.getElementById('picker-hint').textContent = `Photos and videos · ${config.maxFiles} max`;
  document.getElementById('limit-note').textContent = `Send up to ${config.maxFiles} files and ${formatBytes(config.maxTotalBytes)} per batch, then repeat. Videos are saved for us but aren't shown in the album. Some original photo formats may not preview in your browser.`;
  updateSelection();
}).catch(error => setStatus('error', error.message));
refreshName();
refreshSlides();
setInterval(refreshSlides, 10000);
setInterval(() => { if (!document.hidden && slideItems.length) { slideIndex = (slideIndex + 1) % slideItems.length; showSlide(); } }, 7000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshSlides(); });

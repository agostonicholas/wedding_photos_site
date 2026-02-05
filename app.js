// ---- Upload limits (keep in sync with server/config.js) ----
const MAX_FILES = 5; // UI will disable the button if guests select more than this many files
const MAX_BYTES = 100 * 1024 * 1024; // keep total batch size at or below 100 MB
const SIMULATION_MODE = false; // flip to true if you want to demo without the backend
const NAME_STORAGE_KEY = 'weddingUploaderName';
const API_BASE = (window.APP_CONFIG?.apiBase || '').replace(/\/$/, '');

const resolveApiUrl = (path = '') => {
  if (!path) return API_BASE || path;
  if (path.startsWith('http')) return path;
  return API_BASE ? `${API_BASE}${path}` : path;
};

const fetchJson = (path, options = {}) =>
  fetch(resolveApiUrl(path), {
    ...options,
    credentials: 'include',
  });

// Cache frequently accessed DOM nodes so we can update them quickly.
const form = document.getElementById('upload-form');
const fileInput = document.getElementById('photos');
const fileCount = document.getElementById('file-count');
const fileList = document.getElementById('file-list');
const statusEl = document.getElementById('status');
const uploadBtn = document.getElementById('upload-btn');
const slideshowEl = document.getElementById('slideshow');
const welcomeOverlay = document.getElementById('welcome-overlay');
const welcomeForm = document.getElementById('welcome-form');
const welcomeInput = document.getElementById('guest-name-input');
const welcomeError = document.getElementById('welcome-error');
const heroEyebrow = document.getElementById('hero-eyebrow');
const heroHeading = document.getElementById('hero-heading');

let selectedFiles = [];
let guestName = localStorage.getItem(NAME_STORAGE_KEY) || '';
const isImageMime = (type = '') => type.toLowerCase().startsWith('image/');
const slideshowState = {
  items: [],
  activeIndex: 0,
  timer: null,
  interval: 7000,
  maxItems: 24,
};

const setStatus = (state, message) => {
  statusEl.className = `status ${state}`;
  statusEl.textContent = message;
};

const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, power);
  return `${size.toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
};

const renderFileRows = (files) => {
  fileList.innerHTML = '';
  const frag = document.createDocumentFragment();

  files.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-row';
    const rowId = `${file.name}-${file.lastModified}-${index}`;
    li.dataset.id = rowId;
    li.innerHTML = `
      <strong>${file.name}</strong>
      <span class="file-meta">${formatBytes(file.size)}</span>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100">
        <span data-progress></span>
      </div>
    `;
    frag.appendChild(li);
  });

  fileList.appendChild(frag);
};

const clearSlideshowTimer = () => {
  if (slideshowState.timer) {
    clearInterval(slideshowState.timer);
    slideshowState.timer = null;
  }
};

const showSlide = (index) => {
  const slides = slideshowEl ? Array.from(slideshowEl.children) : [];
  slides.forEach((slide) => slide.classList.remove('active'));
  if (slides[index]) {
    slides[index].classList.add('active');
  }
};

const scheduleSlideRotation = () => {
  clearSlideshowTimer();
  if (!slideshowEl || slideshowState.items.length <= 1) {
    showSlide(0);
    return;
  }

  slideshowState.timer = setInterval(() => {
    slideshowState.activeIndex = (slideshowState.activeIndex + 1) % slideshowState.items.length;
    showSlide(slideshowState.activeIndex);
  }, slideshowState.interval);
};

const renderSlideshow = () => {
  if (!slideshowEl) return;
  slideshowEl.innerHTML = '';
  slideshowEl.classList.toggle('is-empty', slideshowState.items.length === 0);

  slideshowState.items.forEach((item, index) => {
    const img = document.createElement('img');
    img.src = item.url;
    img.alt = '';
    if (index === slideshowState.activeIndex) {
      img.classList.add('active');
    }
    slideshowEl.appendChild(img);
  });

  scheduleSlideRotation();
};

const clearSlideshowItems = () => {
  slideshowState.items.forEach((item) => {
    if (item.canRevoke) URL.revokeObjectURL(item.url);
  });
  slideshowState.items = [];
  slideshowState.activeIndex = 0;
};

const pushToSlideshow = (entries = [], { remote = false, replace = false } = {}) => {
  if (!slideshowEl) return;

  if (replace) {
    clearSlideshowItems();
  }

  if (!entries.length) {
    renderSlideshow();
    return;
  }

  const timestamp = Date.now();
  const normalized = entries
    .map((entry) => {
      if (remote) {
        if (!isImageMime(entry?.mimetype || '')) return null;
        const raw = entry.servedPath || entry.url || entry;
        if (!raw) return null;
        const absolute = resolveApiUrl(raw);
        const cacheBust = absolute.includes('?') ? '&' : '?';
        return { url: `${absolute}${cacheBust}t=${timestamp}`, canRevoke: false };
      }
      if (!isImageMime(entry?.type || '')) return null;
      const objectUrl = URL.createObjectURL(entry);
      return { url: objectUrl, canRevoke: true };
    })
    .filter(Boolean);

  if (normalized.length === 0) {
    console.warn('[slideshow] no valid images to display (remote:', remote, ', replace:', replace, ')');
  } else {
    console.log(
      `[slideshow] added ${normalized.length} image${normalized.length === 1 ? '' : 's'} ` +
        `(remote: ${remote}, replace: ${replace})`
    );
  }

  slideshowState.items.push(...normalized);
  while (slideshowState.items.length > slideshowState.maxItems) {
    const removed = slideshowState.items.shift();
    if (removed?.canRevoke) {
      URL.revokeObjectURL(removed.url);
    }
  }

  slideshowState.activeIndex = Math.max(slideshowState.items.length - normalized.length, 0);
  renderSlideshow();
};

// Validates the selected files and toggles the button/status text accordingly.
const updateSelection = () => {
  selectedFiles = Array.from(fileInput.files);
  const fileTotal = selectedFiles.length;
  const capped = Math.min(fileTotal, MAX_FILES);
  fileCount.textContent = `${capped} / ${MAX_FILES} selected`;
  const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);

  if (fileTotal === 0) {
    renderFileRows([]);
    uploadBtn.disabled = true;
    setStatus('idle', 'Idle · waiting for files');
    return;
  }

  if (fileTotal > MAX_FILES) {
    renderFileRows([]);
    uploadBtn.disabled = true;
    setStatus('error', `Too many files (${fileTotal}). Remove ${fileTotal - MAX_FILES} to stay within five.`);
    return;
  }

  if (totalBytes > MAX_BYTES) {
    renderFileRows([]);
    uploadBtn.disabled = true;
    const overBy = formatBytes(totalBytes - MAX_BYTES);
    setStatus('error', `Batch is ${overBy} over 100 MB. Remove a few large files.`);
    return;
  }

  renderFileRows(selectedFiles);
  uploadBtn.disabled = false;
  setStatus('ready', `${fileTotal} selected · approx ${formatBytes(totalBytes)}`);
};

fileInput.addEventListener('change', updateSelection);

const animateProgress = (file, index) => {
  return new Promise((resolve) => {
    const row = fileList.querySelector(`[data-id="${file.name}-${file.lastModified}-${index}"]`);
    if (!row) return resolve();
    const bar = row.querySelector('[data-progress]');
    let progress = 0;
    const duration = 1200 + Math.random() * 1500;
    const stepTime = 60;
    const increment = (stepTime / duration) * 100;
    const tick = () => {
      progress = Math.min(100, progress + increment);
      bar.style.width = `${progress}%`;
      row.setAttribute('aria-label', `${file.name} uploading ${Math.round(progress)}%`);
      if (progress < 100) {
        setTimeout(tick, stepTime);
      } else {
        resolve();
      }
    };
    tick();
  });
};

/**
 * Loads the latest uploads from /api/recent to keep the ambient slideshow fresh.
 */
const fetchRecentUploads = async (replace = true) => {
  try {
    const response = await fetchJson('/api/recent', { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to load recent uploads');
    const payload = await response.json();
    if (payload.ok && Array.isArray(payload.items)) {
      pushToSlideshow(payload.items, { remote: true, replace });
    }
  } catch (error) {
    console.warn('Unable to load recent uploads', error);
    console.warn('[slideshow] fetch recent failed (replace:', replace, ')');
  }
};

const refreshHeroText = () => {
  const displayName = guestName || 'Guest';
  if (heroEyebrow) {
    heroEyebrow.textContent = displayName;
  }
  if (heroHeading) {
    heroHeading.textContent = guestName ? 'Share the Love.' : 'Welcome.';
  }
};

const setGuestName = async (name) => {
  const trimmed = name.trim();
  if (!trimmed) return;
  guestName = trimmed;
  localStorage.setItem(NAME_STORAGE_KEY, guestName);
  refreshHeroText();
  if (welcomeOverlay) welcomeOverlay.hidden = true;
  try {
    await fetchJson('/session/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: guestName }),
    });
  } catch (error) {
    console.warn('Unable to persist guest name on server', error);
  }
};

const requireGuestName = () => {
  if (guestName) return true;
  if (welcomeOverlay) {
    welcomeOverlay.hidden = false;
    welcomeInput?.focus();
  }
  return false;
};

/**
 * Local-only upload simulation for demos without the backend running.
 */
const simulateUpload = async () => {
  if (!selectedFiles.length || !requireGuestName()) return;
  const batch = [...selectedFiles];
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';

  let completed = 0;
  for (const [index, file] of batch.entries()) {
    setStatus('uploading', `Uploading ${index + 1} of ${batch.length}…`);
    await animateProgress(file, index);
    completed += 1;
  }

  setStatus('success', `Uploaded ${completed} file${completed === 1 ? '' : 's'} ✅ Upload more?`);
  pushToSlideshow(batch, { remote: false });
  uploadBtn.disabled = false;
  uploadBtn.textContent = 'Upload More Media';
  fileInput.value = '';
  selectedFiles = [];
  fileCount.textContent = `0 / ${MAX_FILES} selected`;
};

/**
 * Posts selected files to /upload and updates the slideshow with server-confirmed media.
 */
const uploadToServer = async () => {
  if (!selectedFiles.length) return;
  if (!requireGuestName()) {
    setStatus('error', 'Please enter your name before uploading.');
    return;
  }
  uploadBtn.disabled = true;
  uploadBtn.textContent = 'Uploading…';
  setStatus('uploading', `Uploading ${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'}…`);

  const formData = new FormData();
  selectedFiles.forEach((file) => formData.append('photos', file));
  formData.append('uploaderName', guestName);

  try {
    const response = await fetch(resolveApiUrl('/upload'), {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Upload failed. Please try again.');
    }

    const uploadedCount = payload.files?.length || selectedFiles.length;
    setStatus('success', `Uploaded ${uploadedCount} file${uploadedCount === 1 ? '' : 's'} ✅ Upload more?`);

    if (payload.files?.length) {
      pushToSlideshow(payload.files, { remote: true });
      console.log('[slideshow] server returned', payload.files.length, 'file(s) for rotation.');
    } else {
      await fetchRecentUploads();
      console.log('[slideshow] no files returned; fetched recent uploads instead.');
    }
  } catch (error) {
    console.error(error);
    setStatus('error', error.message || 'Upload failed. Try again.');
    console.error('[slideshow] upload-to-server failed', error);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Upload More Media';
    fileInput.value = '';
    selectedFiles = [];
    fileCount.textContent = `0 / ${MAX_FILES} selected`;
    renderFileRows([]);
  }
};

form.addEventListener('submit', (event) => {
  if (!selectedFiles.length) {
    event.preventDefault();
    setStatus('error', 'Select at least one file before uploading.');
    return;
  }

  if (selectedFiles.length > MAX_FILES) {
    event.preventDefault();
    setStatus('error', `Please remove files until only ${MAX_FILES} remain.`);
    return;
  }

  const totalBytes = selectedFiles.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_BYTES) {
    event.preventDefault();
    const overBy = formatBytes(totalBytes - MAX_BYTES);
    setStatus('error', `You're ${overBy} over the 100 MB cap. Trim the batch and try again.`);
    return;
  }

if (SIMULATION_MODE) {
  event.preventDefault();
  simulateUpload();
} else {
  event.preventDefault();
  uploadToServer();
}
});

if (welcomeForm) {
  welcomeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const value = (welcomeInput?.value || '').trim();
    if (!value) {
      if (welcomeError) welcomeError.textContent = 'Please enter your name.';
      return;
    }
    if (welcomeError) welcomeError.textContent = '';
    await setGuestName(value);
  });
}

setStatus('idle', 'Idle · waiting for files');
renderSlideshow();
fetchRecentUploads(true);

if (!guestName && welcomeOverlay) {
  welcomeOverlay.hidden = false;
  welcomeInput?.focus();
}
refreshHeroText();

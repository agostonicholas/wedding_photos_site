const statusEl = document.getElementById('gallery-status');
const gridEl = document.getElementById('gallery-grid');
const filterButtons = document.querySelectorAll('[data-filter]');
const NAME_STORAGE_KEY = 'weddingUploaderName';
const guestName = (localStorage.getItem(NAME_STORAGE_KEY) || '').trim().toLowerCase();
const API_BASE = (window.APP_CONFIG?.apiBase || '').replace(/\/$/, '');

const resolveUrl = (path = '') => {
  if (!path) return API_BASE || path;
  if (path.startsWith('http')) return path;
  return API_BASE ? `${API_BASE}${path}` : path;
};

const fetchJson = (path, options = {}) =>
  fetch(resolveUrl(path), {
    ...options,
    credentials: 'include',
  });

let allItems = [];
let filterMode = 'all';

const formatDate = (timestamp) => {
  const date = new Date(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const renderGallery = (items = []) => {
  gridEl.innerHTML = '';
  if (!items.length) return;

  const fragment = document.createDocumentFragment();

  items.forEach((item) => {
    const card = document.createElement('article');
    card.className = 'gallery-card';
    const img = document.createElement('img');
    img.src = resolveUrl(item.url || '');
    img.alt = 'Wedding upload';
    img.loading = 'lazy';
    const footer = document.createElement('footer');
    const nameLabel = item.uploaderName || 'Guest';
    footer.textContent = `${nameLabel} · ${formatDate(item.uploadedAt)}`;
    card.appendChild(img);
    card.appendChild(footer);
    fragment.appendChild(card);
  });

  gridEl.appendChild(fragment);
};

const applyFilters = () => {
  if (!allItems.length) {
    statusEl.textContent = 'No uploads yet. Be the first to share!';
    gridEl.innerHTML = '';
    return;
  }

  if (filterMode === 'mine') {
    if (!guestName) {
      statusEl.textContent = 'Enter your name on the uploader to see your photos.';
      gridEl.innerHTML = '';
      return;
    }
    const mine = allItems.filter(
      (item) => item.uploaderName && item.uploaderName.trim().toLowerCase() === guestName
    );
    if (!mine.length) {
      statusEl.textContent = 'No photos found for your name yet.';
      gridEl.innerHTML = '';
      return;
    }
    statusEl.textContent = `${mine.length} photo${mine.length === 1 ? '' : 's'} you shared`;
    renderGallery(mine);
  } else {
    statusEl.textContent = `${allItems.length} photo${allItems.length === 1 ? '' : 's'} shared recently`;
    renderGallery(allItems);
  }
};

const loadGallery = async () => {
  statusEl.textContent = 'Loading recent photos…';
  try {
    const response = await fetchJson('/api/gallery?limit=300', { cache: 'no-store' });
    if (!response.ok) {
      if (response.status === 404) {
        statusEl.textContent = 'No gallery available yet. Check back after the first upload.';
        gridEl.innerHTML = '';
        return;
      }
      throw new Error('Failed to load album');
    }
    const payload = await response.json();
    if (!payload.ok) throw new Error(payload.error || 'Gallery unavailable');
    allItems = payload.items || [];
    applyFilters();
  } catch (error) {
    console.error('[album] failed to load', error);
    statusEl.textContent = 'Unable to load album right now. Please refresh in a moment.';
  }
};

filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    filterButtons.forEach((button) => button.classList.remove('active'));
    btn.classList.add('active');
    filterMode = btn.dataset.filter || 'all';
    applyFilters();
  });
});

loadGallery();

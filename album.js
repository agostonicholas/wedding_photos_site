const { json, resolveUrl } = window.Wedding;
// The album does not use configuration, but still handle a configuration request failure.
window.Wedding.config.catch(() => {});
const statusEl = document.getElementById('gallery-status');
const gridEl = document.getElementById('gallery-grid');
const moreButton = document.getElementById('load-more');
const filterButtons = document.querySelectorAll('[data-filter]');
const guestFilter = document.getElementById('guest-filter');
const slideshow = document.getElementById('slideshow');
document.getElementById('album-eyebrow').textContent = window.Wedding.storage.get('weddingUploaderName').trim() || 'Guest';
let filterMode = 'all';
let selectedGuest = '';
let desiredCount = 300;
let loading = false;
let requestVersion = 0;
let renderedSignature = '';
let guestSignature = '';
let slideSignature = '';
let slideIndex = 0;
function renderGuests(names) {
  const guests = [...new Set(names)];
  if (selectedGuest && !guests.includes(selectedGuest)) guests.push(selectedGuest);
  guests.sort((a, b) => a.localeCompare(b));
  const signature = JSON.stringify(guests);
  if (signature === guestSignature) return;
  guestSignature = signature;
  guestFilter.replaceChildren(new Option('All guests', ''));
  for (const name of guests) guestFilter.append(new Option(name, name));
  guestFilter.value = selectedGuest;
}
function showSlide() {
  Array.from(slideshow.children).forEach((image, index) => image.classList.toggle('active', index === slideIndex));
}
function renderSlideshow(items) {
  const photos = items.filter(item => !item.mimetype || item.mimetype.startsWith('image/'));
  const signature = photos.map(item => item.url).join('|');
  if (signature === slideSignature) return;
  slideSignature = signature;
  const active = slideshow.querySelector('.active')?.getAttribute('src');
  slideIndex = Math.max(0, photos.findIndex(item => resolveUrl(item.url) === active));
  slideshow.replaceChildren();
  slideshow.classList.toggle('is-empty', photos.length === 0);
  for (const item of photos) {
    const image = document.createElement('img');
    image.src = resolveUrl(item.url);
    image.alt = '';
    image.addEventListener('error', () => image.remove(), { once: true });
    slideshow.append(image);
  }
  showSlide();
}
function renderGallery(items) {
  const signature = JSON.stringify(items);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = document.createElement('article');
    card.className = 'gallery-card';
    const link = document.createElement('a');
    link.href = resolveUrl(item.url);
    link.target = '_blank';
    link.rel = 'noopener';
    const image = document.createElement('img');
    image.src = resolveUrl(item.url);
    image.alt = `Wedding photo shared by ${item.uploaderName || 'Guest'}`;
    image.loading = 'lazy';
    const footer = document.createElement('footer');
    footer.textContent = `${item.uploaderName || 'Guest'} · ${new Date(item.uploadedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    link.append(image);
    card.append(link, footer);
    fragment.append(card);
  }
  const scrollTop = gridEl.scrollTop;
  gridEl.replaceChildren(fragment);
  gridEl.scrollTop = scrollTop;
}
async function loadGallery() {
  if (loading || document.hidden) return;
  loading = true;
  gridEl.setAttribute('aria-busy', 'true');
  const version = requestVersion;
  const mine = filterMode === 'mine';
  const guest = selectedGuest;
  try {
    let items = [];
    let total = 0;
    let guests;
    let recent;
    do {
      const result = await json(`/api/gallery?limit=${Math.min(1000, desiredCount - items.length)}&offset=${items.length}${mine ? '&mine=true' : ''}${guest ? `&guest=${encodeURIComponent(guest)}` : ''}${items.length === 0 ? '&include=album' : ''}`);
      total = result.total;
      if (items.length === 0) { guests = result.guests; recent = result.recent; }
      items.push(...result.items);
      if (!result.items.length) break;
    } while (items.length < Math.min(desiredCount, total));
    if (version !== requestVersion) return;
    items = [...new Map(items.map(item => [item.id, item])).values()];
    if (Array.isArray(guests)) renderGuests(guests);
    else if (!mine && !guest) renderGuests(items.map(item => item.uploaderName || 'Guest'));
    if (Array.isArray(recent)) renderSlideshow(recent);
    else if (!mine && !guest) renderSlideshow(items.slice(0, 20));
    renderGallery(items);
    statusEl.textContent = items.length
      ? `${items.length} of ${total} photo${total === 1 ? '' : 's'}${mine ? ' in My uploads' : guest ? ` by ${guest}` : ' shared'}`
      : mine ? 'No photos in My uploads yet.' : guest ? `No photos by ${guest} yet.` : 'No uploads yet. Be the first to share!';
    moreButton.hidden = items.length >= total;
  } catch (error) { if (version === requestVersion) statusEl.textContent = error.service?.message || `${error.message} The album will retry automatically.`; }
  finally {
    loading = false;
    gridEl.setAttribute('aria-busy', 'false');
    if (version !== requestVersion) loadGallery();
  }
}
function changeFilter(mode, guest = '') {
  filterMode = mode;
  selectedGuest = guest;
  guestFilter.value = guest;
  filterButtons.forEach(button => {
    const active = button.dataset.filter === mode && !guest;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  desiredCount = 300;
  requestVersion++;
  gridEl.scrollTop = 0;
  statusEl.textContent = 'Loading photos…';
  moreButton.hidden = true;
  loadGallery();
}
filterButtons.forEach(button => button.addEventListener('click', () => changeFilter(button.dataset.filter)));
guestFilter.addEventListener('change', () => changeFilter('all', guestFilter.value));
moreButton.addEventListener('click', () => { desiredCount += 300; loadGallery(); });
loadGallery();
setInterval(loadGallery, 10000);
setInterval(() => {
  if (!document.hidden && slideshow.children.length) {
    slideIndex = (slideIndex + 1) % slideshow.children.length;
    showSlide();
  }
}, 7000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadGallery(); });

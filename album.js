const { json, resolveUrl } = window.Wedding;
// The album does not use configuration, but still handle a configuration request failure.
window.Wedding.config.catch(() => {});
const statusEl = document.getElementById('gallery-status');
const gridEl = document.getElementById('gallery-grid');
const moreButton = document.getElementById('load-more');
const filterButtons = document.querySelectorAll('[data-filter]');
let filterMode = 'all';
let desiredCount = 300;
let loading = false;
let requestVersion = 0;
let renderedSignature = '';
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
  gridEl.replaceChildren(fragment);
}
async function loadGallery() {
  if (loading || document.hidden) return;
  loading = true;
  const version = requestVersion;
  const mine = filterMode === 'mine';
  try {
    let items = [];
    let total = 0;
    do {
      const result = await json(`/api/gallery?limit=${Math.min(1000, desiredCount - items.length)}&offset=${items.length}${mine ? '&mine=true' : ''}`);
      total = result.total;
      items.push(...result.items);
      if (!result.items.length) break;
    } while (items.length < Math.min(desiredCount, total));
    if (version !== requestVersion) return;
    items = [...new Map(items.map(item => [item.id, item])).values()];
    renderGallery(items);
    statusEl.textContent = items.length ? `${items.length} of ${total} photo${total === 1 ? '' : 's'}${mine ? ' uploaded from this browser' : ' shared'}` : (mine ? 'No photos uploaded from this browser yet.' : 'No uploads yet. Be the first to share!');
    moreButton.hidden = items.length >= total;
  } catch (error) { if (version === requestVersion) statusEl.textContent = `${error.message} The album will retry automatically.`; }
  finally { loading = false; if (version !== requestVersion) loadGallery(); }
}
filterButtons.forEach(button => button.addEventListener('click', () => {
  filterButtons.forEach(btn => { const active = btn === button; btn.classList.toggle('active', active); btn.setAttribute('aria-pressed', String(active)); });
  filterMode = button.dataset.filter;
  desiredCount = 300;
  requestVersion++;
  statusEl.textContent = 'Loading photos…';
  moreButton.hidden = true;
  loadGallery();
}));
moreButton.addEventListener('click', () => { desiredCount += 300; loadGallery(); });
loadGallery();
setInterval(loadGallery, 10000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadGallery(); });

const form = document.getElementById('access-form');
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  const errorEl = document.getElementById('access-error');
  button.disabled = true;
  errorEl.textContent = '';
  try {
    const response = await fetch('/session/access', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: document.getElementById('access-code').value }) });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || 'Unable to sign in. Please try again.');
    window.location.assign('/');
  } catch (error) { errorEl.textContent = error.message; }
  finally { button.disabled = false; }
});

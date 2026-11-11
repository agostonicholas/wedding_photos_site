(() => {
  const loginSection = document.getElementById('admin-login');
  const panel = document.getElementById('admin-panel');
  const notice = document.getElementById('admin-notice');
  const loginError = document.getElementById('admin-login-error');
  const dialog = document.getElementById('admin-confirm-dialog');
  const confirmation = document.getElementById('admin-confirm-input');
  const confirmButton = document.getElementById('admin-confirm-submit');
  let csrf = '';
  let paused = false;
  let busy = false;
  let pendingAction = null;
  let ending = false;
  const showLogin = message => {
    panel.hidden = true;
    loginSection.hidden = false;
    notice.textContent = message || '';
  };
  async function api(path, data) {
    const response = await fetch(`/api/admin${path}`, {
      method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-Wedding-CSRF': csrf } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw Object.assign(new Error(payload.error || 'The server is unavailable.'), { status: response.status });
    return payload;
  }
  function disableControls(disabled) {
    panel.querySelectorAll('button').forEach(button => { button.disabled = disabled; });
  }
  async function refresh() {
    if (busy || ending) return;
    try {
      const state = await api('/status');
      csrf = state.csrf;
      paused = state.uploadsPaused;
      loginSection.hidden = true;
      panel.hidden = false;
      disableControls(false);
      document.getElementById('admin-upload-state').textContent = paused ? 'Paused' : 'Accepting photos';
      document.getElementById('admin-active-uploads').textContent = state.activeUploads;
      document.getElementById('admin-storage').textContent = `${(state.storedBytes / 1024 ** 3).toFixed(2)} / ${(state.maxStorageBytes / 1024 ** 3).toFixed(0)} GiB`;
      document.getElementById('admin-pause').textContent = paused ? 'Resume uploads' : 'Pause new uploads';
      document.getElementById('admin-restart').disabled = !state.lifecycleSupported || Boolean(state.lifecyclePending);
      document.getElementById('admin-stop').disabled = !state.lifecycleSupported || Boolean(state.lifecyclePending);
      notice.textContent = !state.lifecycleSupported ? 'Start the app using npm start to enable restart and stop.' : '';
    } catch (error) {
      if (error.status === 401) showLogin();
      else notice.textContent = error.message;
    }
  }
  async function exchange(adminPath) {
    const ticket = new URLSearchParams(new URL(adminPath, window.location.origin).hash.slice(1)).get('login');
    if (!ticket) throw new Error('Enter your admin code again.');
    await api('/exchange', { ticket });
    await refresh();
  }
  document.getElementById('admin-login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const input = document.getElementById('admin-code');
    const code = input.value.trim();
    input.value = '';
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    loginError.textContent = '';
    try { const result = await api('/login', { code }); await exchange(result.adminPath); }
    catch (error) { loginError.textContent = error.message; }
    finally { button.disabled = false; }
  });
  document.getElementById('admin-logout').addEventListener('click', async () => {
    try { await api('/logout', {}); csrf = ''; showLogin('Signed out.'); }
    catch (error) { notice.textContent = error.message; }
  });
  document.getElementById('admin-pause').addEventListener('click', async () => {
    busy = true;
    disableControls(true);
    try { await api('/control', { action: paused ? 'resume' : 'pause' }); }
    catch (error) { notice.textContent = error.message; }
    finally { busy = false; disableControls(false); await refresh(); }
  });
  function confirmAction(action) {
    pendingAction = action;
    confirmation.value = '';
    confirmButton.disabled = true;
    document.getElementById('admin-confirm-title').textContent = action === 'stop' ? 'Stop the server completely?' : 'Restart the server?';
    document.getElementById('admin-confirm-description').textContent = action === 'stop'
      ? 'The photo site will go offline after active requests finish. You will need npm start on the computer to bring it back.'
      : 'The site will briefly go offline after active requests finish. You will need to sign in again when it returns.';
    confirmButton.textContent = action === 'stop' ? 'Stop server' : 'Restart server';
    dialog.showModal();
    confirmation.focus();
  }
  document.getElementById('admin-restart').addEventListener('click', () => confirmAction('restart'));
  document.getElementById('admin-stop').addEventListener('click', () => confirmAction('stop'));
  confirmation.addEventListener('input', () => { confirmButton.disabled = confirmation.value !== 'confirm'; });
  document.getElementById('admin-confirm-cancel').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { pendingAction = null; });
  async function waitForRestart(deadline = Date.now() + 11 * 60 * 1000) {
    if (Date.now() > deadline) {
      ending = false;
      showLogin('The server did not return. Check it on the computer and run npm start if needed.');
      return;
    }
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      if (response.ok) { csrf = ''; ending = false; showLogin('Server restarted. Enter your admin code to sign in again.'); return; }
    } catch { /* The server is still draining requests or restarting. */ }
    setTimeout(() => waitForRestart(deadline), 3000);
  }
  document.getElementById('admin-confirm-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!pendingAction || confirmation.value !== 'confirm' || busy) return;
    const action = pendingAction;
    dialog.close();
    busy = true;
    disableControls(true);
    try {
      const result = await api('/control', { action, confirmation: 'confirm' });
      ending = true;
      notice.textContent = [result.message, result.detail].filter(Boolean).join(' ');
      if (action === 'restart') setTimeout(waitForRestart, 2000);
    } catch (error) { notice.textContent = error.message; disableControls(false); }
    finally { busy = false; }
  });
  const fragment = window.location.hash;
  if (fragment) {
    // Remove the one-use handoff before loading any further resources.
    window.history.replaceState(null, '', '/admin');
    exchange(`/admin${fragment}`).catch(error => showLogin(error.message));
  } else refresh();
  setInterval(() => { if (!document.hidden && !panel.hidden) refresh(); }, 5000);
})();

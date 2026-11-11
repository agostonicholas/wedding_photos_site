const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Browser condition did not complete');
}
function page(t, name, handlers, options = {}) {
  const dom = new JSDOM(source(name), { url: options.url || 'http://127.0.0.1:4000/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  const intervals = [];
  const requests = [];
  window.setInterval = (callback, duration) => { intervals.push({ callback, duration }); return intervals.length; };
  window.fetch = async (url, requestOptions) => {
    requests.push({ url, options: requestOptions });
    const value = await handlers(url, requestOptions);
    const status = options.responseStatus?.(url, value) || 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: name => options.responseHeaders?.[name] || null }, json: async () => value };
  };
  return { window, intervals, requests, run: name => window.eval(source(name)) };
}
const config = { ok: true, maxFiles: 2, maxTotalBytes: 1000, allowedTypes: ['image/png'] };

function introTimers(window) {
  const pending = new Map();
  let next = 0;
  window.setTimeout = (callback, duration) => { pending.set(++next, { callback, duration }); return next; };
  window.clearTimeout = id => pending.delete(id);
  return duration => {
    const timer = [...pending].find(([, value]) => value.duration === duration);
    assert.ok(timer, `Expected intro timer for ${duration}ms`);
    pending.delete(timer[0]);
    timer[1].callback();
  };
}
test('first visit shows the logo before revealing and focusing the name prompt', async t => {
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
  const { window } = view;
  const document = window.document;
  const advance = introTimers(window);
  view.run('intro.js'); view.run('client.js'); view.run('app.js');
  await waitFor(() => !document.getElementById('brand-intro').hidden);
  const overlay = document.getElementById('welcome-overlay');
  const logo = document.getElementById('intro-logo');
  assert.equal(document.documentElement.classList.contains('intro-active'), true);
  assert.equal(overlay.hidden, true);
  assert.equal(document.getElementById('upload-card').inert, true);
  assert.equal(logo.getAttribute('src'), 'logo_large.png');
  logo.dispatchEvent(new window.Event('load'));
  assert.equal(document.getElementById('brand-intro').classList.contains('logo-ready'), true);
  advance(1600);
  assert.equal(document.documentElement.classList.contains('intro-leaving'), true);
  assert.equal(overlay.hidden, false);
  assert.notEqual(document.activeElement, document.getElementById('guest-name-input'));
  advance(650);
  assert.equal(document.getElementById('brand-intro').hidden, true);
  assert.equal(document.documentElement.classList.contains('intro-active'), false);
  assert.equal(document.getElementById('upload-card').inert, false);
  assert.equal(document.activeElement, document.getElementById('guest-name-input'));
  assert.equal(window.localStorage.getItem('weddingUploaderName'), null);
});
test('a saved name skips the intro and large image; removing the name restores it on the next visit', async t => {
  for (const savedName of ['Nick', '', '   ']) {
    const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
    const { window } = view;
    window.localStorage.setItem('weddingUploaderName', savedName);
    const advance = introTimers(window);
    view.run('intro.js'); view.run('client.js'); view.run('app.js');
    await waitFor(() => !window.document.getElementById('photos').disabled);
    const document = window.document;
    if (savedName.trim()) {
      assert.equal(document.getElementById('brand-intro').hidden, true);
      assert.equal(document.documentElement.classList.contains('intro-active'), false);
      assert.equal(document.getElementById('intro-logo').hasAttribute('src'), false);
      assert.equal(document.querySelector('link[rel="preload"]'), null);
      document.getElementById('hero-eyebrow').click();
      assert.equal(document.getElementById('welcome-overlay').hidden, false);
      assert.equal(document.documentElement.classList.contains('intro-active'), false);
    } else {
      assert.equal(document.getElementById('brand-intro').hidden, false);
      advance(4500); advance(650);
      assert.equal(document.getElementById('welcome-overlay').hidden, false);
    }
  }
});
test('missing or stalled intro images never prevent name entry, including with reduced motion', async t => {
  for (const failure of ['error', 'timeout', 'reduced-motion']) {
    const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
    const { window } = view;
    const document = window.document;
    window.matchMedia = () => ({ matches: failure === 'reduced-motion' });
    const advance = introTimers(window);
    view.run('intro.js'); view.run('client.js'); view.run('app.js');
    await waitFor(() => !document.getElementById('brand-intro').hidden);
    if (failure === 'error') document.getElementById('intro-logo').dispatchEvent(new window.Event('error'));
    else if (failure === 'timeout') advance(4500);
    else { document.getElementById('intro-logo').dispatchEvent(new window.Event('load')); advance(1600); }
    if (failure !== 'reduced-motion') advance(650);
    assert.equal(document.getElementById('brand-intro').hidden, true);
    assert.equal(document.getElementById('welcome-overlay').inert, false);
    assert.equal(document.activeElement, document.getElementById('guest-name-input'));
  }
});

test('uploader loads server limits and renders untrusted filenames as text', async t => {
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
  view.window.localStorage.setItem('weddingUploaderName', 'Guest');
  view.run('client.js'); view.run('app.js');
  const document = view.window.document;
  await waitFor(() => !document.getElementById('photos').disabled);
  assert.equal(document.getElementById('upload-btn').hidden, true);
  assert.equal(document.getElementById('photos').accept, 'image/png');
  assert.match(document.getElementById('picker-hint').textContent, /2 max/);
  const input = document.getElementById('photos');
  const filename = '<img src=x onerror="alert(1)">.png';
  Object.defineProperty(input, 'files', { configurable: true, value: [new view.window.File(['data'], filename, { type: 'image/png' })] });
  input.dispatchEvent(new view.window.Event('change'));
  assert.equal(document.querySelector('.file-row strong').textContent, filename);
  assert.equal(document.querySelector('.file-row img'), null);
  assert.equal(document.getElementById('upload-btn').disabled, false);
  assert.equal(document.getElementById('upload-btn').hidden, false);
});
test('failed uploads keep files selected, show real progress, and can be retried', async t => {
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [] });
  const { window } = view;
  window.localStorage.setItem('weddingUploaderName', 'Guest');
  let attempt = 0;
  class FakeXHR extends window.EventTarget {
    constructor() { super(); this.upload = new window.EventTarget(); }
    open(method, url) { assert.equal(method, 'POST'); assert.equal(url, '/upload'); }
    send() {
      attempt++;
      queueMicrotask(() => {
        const document = window.document;
        assert.equal(document.getElementById('upload-card').hidden, true);
        assert.equal(document.getElementById('upload-splash').hidden, false);
        assert.ok(document.querySelector('#upload-progress-files #file-list'));
        assert.ok(document.body.classList.contains('is-uploading'));
        assert.match(document.getElementById('upload-warning').textContent, /Do not close the browser.*cancel/);
        assert.equal(document.querySelector('progress').value, 0);
        const leaving = new window.Event('beforeunload', { cancelable: true });
        window.dispatchEvent(leaving);
        assert.equal(leaving.defaultPrevented, true);
        this.upload.dispatchEvent(new window.ProgressEvent('progress', { lengthComputable: true, loaded: 50, total: 100 }));
        assert.equal(window.document.querySelector('progress').value, 50);
        assert.match(document.getElementById('upload-progress-text').textContent, /50%/);
        if (attempt === 1) this.dispatchEvent(new window.Event('error'));
        else { this.status = 200; this.responseText = JSON.stringify({ ok: true, files: [{}] }); this.dispatchEvent(new window.Event('load')); }
      });
    }
  }
  window.XMLHttpRequest = FakeXHR;
  view.run('client.js'); view.run('app.js');
  const document = window.document;
  const input = document.getElementById('photos');
  await waitFor(() => !input.disabled);
  let files = [new window.File(['data'], 'photo.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { get: () => files });
  Object.defineProperty(input, 'value', { get: () => files.length ? 'photo.png' : '', set: value => { if (!value) files = []; } });
  input.dispatchEvent(new window.Event('change'));
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => document.getElementById('upload-btn').textContent === 'Retry Upload');
  assert.equal(input.files.length, 1);
  assert.equal(document.getElementById('upload-btn').hidden, false);
  assert.match(document.getElementById('status').textContent, /still selected/);
  assert.equal(input.disabled, false);
  assert.equal(document.getElementById('upload-card').hidden, false);
  assert.equal(document.getElementById('upload-splash').hidden, true);
  assert.ok(document.querySelector('#selected-files #file-list'));
  assert.equal(document.body.classList.contains('is-uploading'), false);
  const afterFailure = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(afterFailure);
  assert.equal(afterFailure.defaultPrevented, false);
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => input.files.length === 0);
  assert.match(document.getElementById('status').textContent, /Uploaded 1/);
  assert.equal(document.getElementById('upload-btn').hidden, true);
  assert.equal(document.getElementById('upload-card').hidden, false);
  assert.equal(document.getElementById('upload-splash').hidden, true);
  const afterSuccess = new window.Event('beforeunload', { cancelable: true });
  window.dispatchEvent(afterSuccess);
  assert.equal(afterSuccess.defaultPrevented, false);
});
test('slideshow polls without changing image URLs or rebuilding unchanged slides', async t => {
  const item = { id: 'one', mimetype: 'image/png', url: '/media/0/main-event/2026-01-01/photo.png' };
  const view = page(t, 'index.html', async url => url === '/api/config' ? config : { ok: true, items: [item] });
  view.window.localStorage.setItem('weddingUploaderName', 'Guest');
  view.run('client.js'); view.run('app.js');
  await waitFor(() => view.window.document.querySelector('#slideshow img'));
  const image = view.window.document.querySelector('#slideshow img');
  const refresh = view.intervals.find(interval => interval.duration === 10000);
  assert.ok(refresh);
  await refresh.callback();
  assert.equal(view.window.document.querySelector('#slideshow img'), image);
  assert.equal(image.getAttribute('src'), item.url);
});
test('album polls, preserves safe labels, and requests browser ownership from the server', async t => {
  let count = 0;
  const view = page(t, 'album.html', async url => {
    if (url === '/api/config') return config;
    count++;
    return { ok: true, total: url.includes('mine=true') ? 0 : 1, items: url.includes('mine=true') ? [] : [{ id: 'one', uploaderName: '<img src=x>', url: '/media/0/main-event/2026-01-01/photo.png', uploadedAt: 1 }] };
  });
  view.run('client.js'); view.run('album.js');
  const document = view.window.document;
  await waitFor(() => document.querySelector('.gallery-card'));
  assert.match(document.querySelector('.gallery-card footer').textContent, /<img src=x>/);
  assert.equal(document.querySelectorAll('.gallery-card img').length, 1);
  await view.intervals.find(interval => interval.duration === 10000).callback();
  assert.equal(count, 2);
  document.querySelector('[data-filter="mine"]').click();
  await waitFor(() => document.getElementById('gallery-status').textContent.includes('No photos uploaded'));
  assert.ok(view.requests.some(request => request.url.includes('mine=true')));
  assert.equal(document.querySelectorAll('.gallery-card').length, 0);
});
test('GitHub Pages routes API requests, slideshow images, and uploads to the home backend', async t => {
  const backend = 'https://nickserverphotodump.duckdns.org';
  const token = `${'a'.repeat(32)}.${'b'.repeat(64)}`;
  const item = { id: 'one', mimetype: 'image/png', url: '/media/0/main-event/2026-01-01/photo.png' };
  const view = page(t, 'index.html', async url => url.endsWith('/api/config') ? config : { ok: true, items: [item] }, {
    url: 'https://agostonicholas.github.io/wedding_photos_site/',
    responseHeaders: { 'X-Wedding-Device': token },
  });
  const { window } = view;
  window.localStorage.setItem('weddingUploaderName', 'Guest');
  let uploadUrl;
  const uploadHeaders = {};
  class FakeXHR extends window.EventTarget {
    constructor() { super(); this.upload = new window.EventTarget(); }
    open(method, url) { assert.equal(method, 'POST'); uploadUrl = url; }
    setRequestHeader(name, value) { uploadHeaders[name] = value; }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ ok: true, files: [{}] });
      queueMicrotask(() => this.dispatchEvent(new window.Event('load')));
    }
  }
  window.XMLHttpRequest = FakeXHR;
  view.run('site-config.js'); view.run('client.js'); view.run('app.js');
  const document = window.document;
  const input = document.getElementById('photos');
  await waitFor(() => !input.disabled && document.querySelector('#slideshow img'));
  assert.equal(view.requests[0].url, backend + '/api/config');
  const recent = view.requests.find(request => request.url.endsWith('/api/recent'));
  assert.equal(recent.url, backend + '/api/recent');
  assert.equal(recent.options.headers['X-Wedding-Device'], token);
  assert.equal(recent.options.credentials, 'omit');
  assert.equal(document.querySelector('#slideshow img').src, backend + item.url);
  let files = [new window.File(['data'], 'photo.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { get: () => files });
  Object.defineProperty(input, 'value', { get: () => files.length ? 'photo.png' : '', set: value => { if (!value) files = []; } });
  input.dispatchEvent(new window.Event('change'));
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await waitFor(() => !input.files.length);
  assert.equal(uploadUrl, backend + '/upload');
  assert.equal(uploadHeaders['X-Wedding-Device'], token);
  assert.equal(window.localStorage.getItem(`weddingDevice:${backend}`), token);
});
test('GitHub Pages album uses backend URLs for both images and original links', async t => {
  const backend = 'https://nickserverphotodump.duckdns.org';
  const view = page(t, 'album.html', async url => url.endsWith('/api/config') ? config : {
    ok: true, total: 1, items: [{ id: 'one', uploaderName: 'Guest', url: '/media/0/main-event/2026-01-01/photo.png', uploadedAt: 1 }],
  }, { url: 'https://agostonicholas.github.io/wedding_photos_site/album.html' });
  view.run('site-config.js'); view.run('client.js'); view.run('album.js');
  await waitFor(() => view.window.document.querySelector('.gallery-card'));
  for (const element of view.window.document.querySelectorAll('.gallery-card a, .gallery-card img')) {
    assert.ok((element.href || element.src).startsWith(backend + '/media/'));
  }
  assert.ok(view.requests.every(request => request.url.startsWith(backend + '/api/')));
});
test('server-hosted and LAN pages keep using their own origin', async t => {
  const view = page(t, 'index.html', async () => config, { url: 'http://192.168.1.32:4000/' });
  view.run('site-config.js'); view.run('client.js');
  await view.window.Wedding.config;
  assert.equal(view.window.APP_CONFIG.apiBase, '');
  assert.equal(view.requests[0].url, '/api/config');
  assert.equal(view.requests[0].options.credentials, 'same-origin');
});
test('upload splash shows saving state and closes without waiting for slideshow refresh', async t => {
  let recentRequests = 0;
  const item = { id: 'one', mimetype: 'image/png', url: '/media/0/main-event/2026-01-01/photo.png' };
  const view = page(t, 'index.html', async url => {
    if (url === '/api/config') return config;
    if (++recentRequests > 1) return new Promise(() => {});
    return { ok: true, items: [item] };
  });
  const { window } = view;
  window.localStorage.setItem('weddingUploaderName', 'Guest');
  let activeRequest;
  class FakeXHR extends window.EventTarget {
    constructor() { super(); this.upload = new window.EventTarget(); activeRequest = this; }
    open() {}
    send() {}
  }
  window.XMLHttpRequest = FakeXHR;
  view.run('client.js'); view.run('app.js');
  const document = window.document;
  const input = document.getElementById('photos');
  await waitFor(() => !input.disabled && document.querySelector('#slideshow img'));
  let files = [new window.File(['data'], 'photo.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { get: () => files });
  Object.defineProperty(input, 'value', { get: () => files.length ? 'photo.png' : '', set: value => { if (!value) files = []; } });
  input.dispatchEvent(new window.Event('change'));
  document.getElementById('upload-form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  assert.equal(document.activeElement, document.getElementById('upload-splash'));
  activeRequest.upload.dispatchEvent(new window.ProgressEvent('progress', { lengthComputable: true, loaded: 100, total: 100 }));
  assert.equal(document.querySelector('#upload-splash progress').value, 100);
  assert.equal(document.getElementById('upload-progress-text').textContent, 'Saving your files…');
  assert.equal(document.getElementById('upload-card').hidden, true);
  assert.equal(document.querySelector('#slideshow img').getAttribute('src'), item.url);
  activeRequest.status = 200;
  activeRequest.responseText = JSON.stringify({ ok: true, files: [{}] });
  activeRequest.dispatchEvent(new window.Event('load'));
  await waitFor(() => !document.getElementById('upload-card').hidden);
  assert.equal(document.getElementById('upload-splash').hidden, true);
  assert.equal(document.activeElement, document.getElementById('hero-heading'));
  assert.equal(recentRequests, 2);
});
test('admin code entered as a name is masked and never saved as a guest name', async t => {
  const code=`admin-${'a'.repeat(32)}`;
  const view=page(t,'index.html',async url=>{
    if(url==='/api/config')return {...config,adminEntryEnabled:true};
    if(url==='/session/name')return {ok:true,admin:true,adminPath:'/admin#login=one-use-ticket'};
    return {ok:true,items:[]};
  },{url:'http://127.0.0.1:4000/admin'});
  const {window}=view;const document=window.document;
  window.localStorage.setItem('weddingUploaderName','Nick');
  view.run('client.js');view.run('app.js');
  await waitFor(()=>!document.getElementById('photos').disabled);
  document.getElementById('hero-eyebrow').click();
  const input=document.getElementById('guest-name-input');input.value=code;input.dispatchEvent(new window.Event('input'));
  assert.equal(input.type,'password');assert.equal(input.autocomplete,'off');
  document.getElementById('welcome-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await waitFor(()=>window.location.hash==='#login=one-use-ticket');
  assert.equal(window.localStorage.getItem('weddingUploaderName'),'Nick');
  assert.equal(input.value,'');
  assert.equal(document.getElementById('hero-eyebrow').textContent,'Nick');
});
test('admin stop requires typing confirm and supports canceling without a server command', async t => {
  const commands=[];
  const state={ok:true,csrf:'test-csrf',uploadsPaused:false,activeUploads:0,storedBytes:0,maxStorageBytes:1024**3,lifecycleSupported:true};
  const view=page(t,'admin.html',async (url,options)=>{
    if(url==='/api/admin/status')return state;
    if(url==='/api/admin/control'){commands.push({body:JSON.parse(options.body),headers:options.headers});return {ok:true,message:'Server stopping. Start it locally with npm start.'};}
    return {ok:true};
  });
  const {window}=view;const document=window.document;
  const dialog=document.getElementById('admin-confirm-dialog');
  dialog.showModal=()=>{dialog.open=true;};
  dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new window.Event('close'));};
  view.run('admin.js');
  await waitFor(()=>!document.getElementById('admin-panel').hidden);
  document.getElementById('admin-stop').click();
  assert.equal(dialog.open,true);
  const input=document.getElementById('admin-confirm-input');
  const submit=document.getElementById('admin-confirm-submit');
  assert.equal(submit.disabled,true);
  document.getElementById('admin-confirm-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.equal(commands.length,0);
  input.value='CONFIRM';input.dispatchEvent(new window.Event('input'));assert.equal(submit.disabled,true);
  document.getElementById('admin-confirm-cancel').click();assert.equal(commands.length,0);assert.equal(dialog.open,false);
  document.getElementById('admin-stop').click();assert.equal(input.value,'');
  input.value='confirm';input.dispatchEvent(new window.Event('input'));assert.equal(submit.disabled,false);
  document.getElementById('admin-confirm-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  await waitFor(()=>commands.length===1);
  assert.deepEqual(commands[0].body,{action:'stop',confirmation:'confirm'});
  assert.equal(commands[0].headers['X-Wedding-CSRF'],'test-csrf');
  assert.equal(document.getElementById('admin-stop').disabled,true);
});
test('an outdated backend never receives an owner code as a guest name', async t => {
  const view=page(t,'index.html',async url=>url==='/api/config'?config:{ok:true,items:[]});
  const {window}=view;const document=window.document;
  view.run('client.js');view.run('app.js');
  await waitFor(()=>!document.getElementById('photos').disabled);
  const input=document.getElementById('guest-name-input');input.value=`admin-${'a'.repeat(32)}`;
  document.getElementById('welcome-form').dispatchEvent(new window.Event('submit',{cancelable:true}));
  assert.equal(view.requests.some(request=>request.url==='/session/name'),false);
  assert.match(document.getElementById('welcome-error').textContent,/not enabled/);
  assert.equal(window.localStorage.getItem('weddingUploaderName'),null);
});
test('clearing a file selection hides Upload again', async t => {
  const view=page(t,'index.html',async url=>url==='/api/config'?config:{ok:true,items:[]});
  view.window.localStorage.setItem('weddingUploaderName','Guest');
  view.run('client.js');view.run('app.js');
  const document=view.window.document;const input=document.getElementById('photos');
  await waitFor(()=>!input.disabled);
  let files=[new view.window.File(['data'],'photo.png',{type:'image/png'})];
  Object.defineProperty(input,'files',{get:()=>files});
  input.dispatchEvent(new view.window.Event('change'));assert.equal(document.getElementById('upload-btn').hidden,false);
  files=[];input.dispatchEvent(new view.window.Event('change'));assert.equal(document.getElementById('upload-btn').hidden,true);
});
test('guest service messages follow pause, restart, stop, and recovery without losing selected files', async t => {
  const messages={paused:'We paused uploads for a bit -Nick',stopped:'Service not running right now -Nick',restarting:'Service is restarting -Nick'};
  let state='online';
  const view=page(t,'index.html',async url=>{
    const service={state,message:messages[state]||''};
    if(state==='stopped'||state==='restarting')return {ok:false,error:service.message,service};
    return url==='/api/config'?{...config,uploadsPaused:state==='paused',service}:{ok:true,items:[],service};
  },{responseStatus:(_url,payload)=>payload.ok?200:503});
  view.window.localStorage.setItem('weddingUploaderName','Guest');view.run('client.js');view.run('app.js');
  const document=view.window.document;const input=document.getElementById('photos');
  await waitFor(()=>!input.disabled);
  const files=[new view.window.File(['data'],'photo.png',{type:'image/png'})];Object.defineProperty(input,'files',{get:()=>files});input.dispatchEvent(new view.window.Event('change'));
  const check=view.intervals.filter(interval=>interval.duration===10000)[1].callback;
  state='paused';await check();
  assert.equal(document.getElementById('service-message').textContent,messages.paused);
  assert.equal(input.disabled,true);assert.equal(document.getElementById('upload-btn').disabled,true);assert.equal(document.getElementById('upload-form').hidden,false);
  for(const unavailable of ['restarting','stopped']){
    state=unavailable;await check();
    assert.equal(document.getElementById('service-message').textContent,messages[unavailable]);
    assert.equal(document.getElementById('upload-form').hidden,true);
  }
  state='online';await check();
  assert.equal(document.getElementById('service-message').hidden,true);assert.equal(document.getElementById('upload-form').hidden,false);
  assert.equal(input.disabled,false);assert.equal(input.files.length,1);assert.equal(document.getElementById('upload-btn').hidden,false);assert.equal(document.getElementById('upload-btn').disabled,false);
});
test('GitHub Pages recovers when the backend was offline during its initial configuration request', async t => {
  let online=false;
  const view=page(t,'index.html',async url=>online
    ?(url.endsWith('/api/config')?config:{ok:true,items:[]})
    :{ok:false,error:'Service not running right now -Nick',service:{state:'stopped',message:'Service not running right now -Nick'}},
  {url:'https://agostonicholas.github.io/wedding_photos_site/',responseStatus:(_url,payload)=>payload.ok?200:503});
  view.window.localStorage.setItem('weddingUploaderName','Guest');view.run('site-config.js');view.run('client.js');view.run('app.js');
  await waitFor(()=>view.window.document.getElementById('service-message').textContent.includes('Service not running'));
  online=true;await view.intervals.filter(interval=>interval.duration===10000)[1].callback();
  assert.equal(view.window.document.getElementById('photos').disabled,false);
  assert.equal(view.window.document.getElementById('service-message').hidden,true);
});

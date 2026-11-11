const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createApp } = require('../server');
const { createConfig } = require('../server/config');
const CODE = `admin-${'a'.repeat(32)}`;
const HASH = `sha256:${createHash('sha256').update(CODE).digest('hex')}`;
const json = data => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
function client(base) {
  const cookies = new Map();
  return {
    cookies,
    async request(url, options = {}) {
      const response = await fetch(base + url, { redirect: 'manual', ...options, headers: { cookie: [...cookies].map(([key,value]) => `${key}=${value}`).join('; '), ...options.headers } });
      for (const cookie of response.headers.getSetCookie()) {
        const item = cookie.split(';')[0];const separator = item.indexOf('=');
        cookies.set(item.slice(0,separator), item.slice(separator+1));
      }
      return response;
    },
  };
}
async function login(browser, route = '/session/name') {
  const response = await browser.request(route, json(route === '/session/name' ? { name: CODE } : { code: CODE }));
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.admin, true);
  assert.equal(payload.name, undefined);
  const ticket = new URLSearchParams(new URL(payload.adminPath, 'http://localhost').hash.slice(1)).get('login');
  const exchange = await browser.request('/api/admin/exchange', json({ ticket }));
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const state = await (await browser.request('/api/admin/status')).json();
  assert.equal(state.ok, true);
  return { state, ticket, exchange };
}
async function setup(t, env = {}, dependencies = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wedding-admin-'));
  const config = createConfig({ NODE_ENV: 'test', PHOTO_STORAGE_ROOT: dir, LEGACY_STORAGE_ROOTS: '', ADMIN_CODE_HASH: HASH, ...env });
  const app = await createApp(config, dependencies);
  const server = await new Promise(resolve => { const instance = app.listen(0,'127.0.0.1',()=>resolve(instance)); });
  t.after(async () => { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true}); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { config, server, base, browser: client(base) };
}
function command(state, action, confirmation) {
  const options = json({ action, ...(confirmation === undefined ? {} : { confirmation }) });
  options.headers['X-Wedding-CSRF'] = state.csrf;
  return options;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOxoAAAAASUVORK5CYII=', 'base64');
function upload(name = 'Guest') {
  const form = new FormData();form.append('photos',new Blob([PNG],{type:'image/png'}),'photo.png');form.append('uploaderName',name);
  return { method:'POST',body:form };
}

test('owner code creates an admin handoff without becoming a guest name', async t => {
  const { browser } = await setup(t);
  const { state, ticket, exchange } = await login(browser);
  assert.equal(browser.cookies.has('wedding_guest_name'), false);
  assert.equal(state.lifecycleSupported, false);
  const adminCookie = exchange.headers.getSetCookie().find(value => value.startsWith('wedding_admin='));
  assert.match(adminCookie,/HttpOnly/);assert.match(adminCookie,/SameSite=Strict/);
  assert.equal((await browser.request('/api/admin/exchange',json({ticket}))).status,401);
  assert.equal((await browser.request('/upload',upload(CODE))).status,400);
  assert.equal((await (await browser.request('/api/gallery')).json()).total,0);
  assert.equal(JSON.stringify(state).includes(CODE),false);
});
test('normal guests still save names while guessed admin names are never persisted', async t => {
  const { browser } = await setup(t);
  for (let attempt=0;attempt<10;attempt++) assert.equal((await browser.request('/session/name',json({name:'admin-wrong'}))).status,401);
  assert.equal((await browser.request('/session/name',json({name:CODE}))).status,429);
  assert.equal(browser.cookies.has('wedding_guest_name'),false);
  assert.equal((await browser.request('/session/name',json({name:'Nick'}))).status,200);
  assert.equal(browser.cookies.get('wedding_guest_name'),'Nick');
  assert.equal((await browser.request('/api/admin/status')).status,401);
});
test('admin APIs reject guest tokens, missing confirmation, CSRF, and foreign origins', async t => {
  const actions=[];
  const { browser } = await setup(t, { CORS_ORIGINS:'https://agostonicholas.github.io' }, { requestLifecycle: action=>actions.push(action) });
  assert.equal((await browser.request('/api/admin/control',json({action:'stop',confirmation:'confirm'}))).status,401);
  const { state } = await login(browser);
  assert.equal((await browser.request('/api/admin/control',json({action:'stop',confirmation:'confirm'}))).status,403);
  for (const value of [undefined,'Confirm','confirm ','yes']) assert.equal((await browser.request('/api/admin/control',command(state,'stop',value))).status,400);
  const foreign=command(state,'stop','confirm');foreign.headers.Origin='https://agostonicholas.github.io';
  assert.equal((await browser.request('/api/admin/control',foreign)).status,403);
  assert.equal((await browser.request('/api/admin/control',command(state,'reboot-computer','confirm'))).status,400);
  assert.deepEqual(actions,[]);
  assert.equal((await browser.request('/api/admin/control',command(state,'stop','confirm'))).status,202);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(actions,['stop']);
  assert.equal((await browser.request('/api/admin/control',command(state,'restart','confirm'))).status,409);
});
test('pause survives restart, blocks new uploads, and can be resumed', async t => {
  const { config, browser, base } = await setup(t);
  const { state } = await login(browser);
  assert.equal((await browser.request('/api/admin/control',command(state,'pause'))).status,200);
  const paused=await browser.request('/upload',upload());
  assert.equal(paused.status,503);
  assert.equal((await paused.json()).error,'We paused uploads for a bit -Nick');
  assert.equal((await browser.request('/api/gallery')).status,200);
  const second=await createApp(config);
  const secondServer=await new Promise(resolve=>{const server=second.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(async()=>{secondServer.closeAllConnections();await new Promise(resolve=>secondServer.close(resolve));});
  const secondBase=`http://127.0.0.1:${secondServer.address().port}`;
  assert.equal((await (await fetch(secondBase+'/api/config')).json()).uploadsPaused,true);
  assert.equal((await browser.request('/api/admin/control',command(state,'resume'))).status,200);
  assert.equal((await browser.request('/upload',upload())).status,200);
  assert.equal((await fetch(base+'/api/config')).status,200);
});
test('logout revokes the session and signed guest IDs never grant admin access', async t => {
  const { browser, base } = await setup(t);
  const { state } = await login(browser);
  const token=browser.cookies.get('wedding_admin');
  assert.equal((await browser.request('/api/admin/logout',{...json({}),headers:{'Content-Type':'application/json','X-Wedding-CSRF':state.csrf}})).status,200);
  const response=await fetch(base+'/api/admin/status',{headers:{cookie:`wedding_admin=${token}`}});
  assert.equal(response.status,401);
  assert.equal((await fetch(base+'/api/admin/status',{headers:{cookie:`wedding_admin=${browser.cookies.get('wedding_device')}`}})).status,401);
});
test('admin login uses secure cookies behind the trusted HTTPS proxy', async t => {
  const { browser } = await setup(t,{TRUST_PROXY:'loopback'});
  const response=await browser.request('/api/admin/login',{...json({code:CODE}),headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https'}});
  const path=(await response.json()).adminPath;
  const ticket=new URLSearchParams(new URL(path,'https://localhost').hash.slice(1)).get('login');
  const exchange=await browser.request('/api/admin/exchange',{...json({ticket}),headers:{'Content-Type':'application/json','X-Forwarded-Proto':'https'}});
  assert.match(exchange.headers.getSetCookie().find(cookie=>cookie.startsWith('wedding_admin=')),/; Secure/);
});
test('GitHub Pages admin handoff works without third-party cookies and disabled admin rejects codes', async t => {
  const { base } = await setup(t,{CORS_ORIGINS:'https://agostonicholas.github.io'});
  const response=await fetch(base+'/session/name',{...json({name:CODE}),headers:{'Content-Type':'application/json',Origin:'https://agostonicholas.github.io'}});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('access-control-allow-origin'),'https://agostonicholas.github.io');
  assert.equal(response.headers.getSetCookie().some(cookie=>cookie.startsWith('wedding_guest_name=')),false);
  const payload=await response.json();assert.ok(payload.adminPath.startsWith('/admin#login='));
  const disabled=await setup(t,{ADMIN_CODE_HASH:''});
  assert.equal((await disabled.browser.request('/session/name',json({name:CODE}))).status,401);
});
test('supervised server restarts then fully stops only after typed confirmation', async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wedding-supervisor-'));
  const child=spawn(process.execPath,[path.join(__dirname,'..','server/supervisor.js')],{
    env:{...process.env,NODE_ENV:'test',PHOTO_STORAGE_ROOT:dir,WEDDING_STATUS_DIR:path.join(dir,'public-status'),LEGACY_STORAGE_ROOTS:'',HOST:'127.0.0.1',PORT:'0',ACCESS_CODE:'',ADMIN_CODE_HASH:HASH},
    stdio:['ignore','pipe','pipe'],
  });
  let output='',errors='';
  let streamingRequest;
  child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{errors+=data;});
  const exited=once(child,'exit');
  t.after(async()=>{
    streamingRequest?.destroy();
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exited;}
    await fs.rm(dir,{recursive:true,force:true});
  });
  async function waitForCount(count){
    for(let index=0;index<200;index++){
      const matches=[...output.matchAll(/Wedding uploader listening on (http:\/\/127\.0\.0\.1:\d+)/g)];
      if(matches.length>=count)return matches[count-1][1];
      if(child.exitCode!==null)assert.fail(`Supervisor exited: ${errors}`);
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.fail(`Server did not become ready: ${output} ${errors}`);
  }
  const firstBase=await waitForCount(1);
  const first=client(firstBase);const initial=await login(first);
  assert.equal(initial.state.lifecycleSupported,true);
  assert.equal((await first.request('/api/admin/control',command(initial.state,'restart','confirm'))).status,202);
  const nextBase=await waitForCount(2);
  assert.equal((await fetch(nextBase+'/health')).status,200);
  const stale=await fetch(nextBase+'/api/admin/status',{headers:{cookie:`wedding_admin=${first.cookies.get('wedding_admin')}`}});
  assert.equal(stale.status,401);
  const second=client(nextBase);const fresh=await login(second,'/api/admin/login');
  assert.equal((await second.request('/api/admin/control',command(fresh.state,'stop'))).status,400);
  assert.equal((await fetch(nextBase+'/health')).status,200);
  const boundary='admin-drain-test';
  const header=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photos"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`);
  const body=Buffer.concat([header,PNG,Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const uploadResponse=new Promise((resolve,reject)=>{
    streamingRequest=require('node:http').request(nextBase+'/upload',{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':body.length}},response=>{
      let payload='';response.setEncoding('utf8');response.on('data',data=>payload+=data);response.on('end',()=>resolve({status:response.statusCode,payload}));
    });
    streamingRequest.on('error',reject);
    streamingRequest.write(body.subarray(0,header.length+10));
  });
  let active=false;
  for(let attempt=0;attempt<50;attempt++){
    const status=await (await second.request('/api/admin/status')).json();
    if(status.activeUploads===1){active=true;break;}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(active,true);
  assert.equal((await second.request('/api/admin/control',command(fresh.state,'stop','confirm'))).status,202);
  streamingRequest.end(body.subarray(header.length+10));
  const finished=await uploadResponse;
  assert.equal(finished.status,200,finished.payload);
  assert.equal(JSON.parse(finished.payload).ok,true);
  const result=await Promise.race([exited,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Supervisor did not stop')),5000);timer.unref();})]);
  assert.equal(result[0],0);
  const stopped=JSON.parse(await fs.readFile(path.join(dir,'public-status','status.json'),'utf8'));
  assert.equal(stopped.service.state,'stopped');
  assert.equal(stopped.error,'Service not running right now -Nick');
  await assert.rejects(fetch(nextBase+'/health'));
});

test('admin tickets and sessions expire, and plain HTTP from a proxied remote client is rejected', async t => {
  const realNow=Date.now;
  let offset=0;
  t.mock.method(Date,'now',()=>realNow()+offset);
  const { browser } = await setup(t,{TRUST_PROXY:'loopback'});
  const insecure=json({code:CODE});insecure.headers['X-Forwarded-For']='198.51.100.12';insecure.headers['X-Forwarded-Proto']='http';
  assert.equal((await browser.request('/api/admin/login',insecure)).status,403);
  const response=await browser.request('/api/admin/login',json({code:CODE}));
  const payload=await response.json();
  const ticket=new URLSearchParams(new URL(payload.adminPath,'http://localhost').hash.slice(1)).get('login');
  offset+=61000;
  assert.equal((await browser.request('/api/admin/exchange',json({ticket}))).status,401);
  await login(browser);
  offset+=31*60*1000;
  assert.equal((await browser.request('/api/admin/status')).status,401);
});
test('supervisor exits with a clear error instead of hanging on an occupied port', async t => {
  const { base, config } = await setup(t);
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  await assert.rejects(promisify(execFile)(process.execPath,[path.join(__dirname,'..','server/supervisor.js')],{
    env:{...process.env,NODE_ENV:'test',PHOTO_STORAGE_ROOT:config.uploadsRoot,WEDDING_STATUS_DIR:path.join(config.uploadsRoot,'public-status'),LEGACY_STORAGE_ROOTS:'',HOST:'127.0.0.1',PORT:new URL(base).port,ADMIN_CODE_HASH:HASH,ACCESS_CODE:''},timeout:5000,
  }),error=>{assert.equal(error.code,1);assert.match(error.stderr,/already in use/);return true;});
  assert.equal((await fetch(base+'/health')).status,200);
});

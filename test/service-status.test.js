const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const { spawn }=require('node:child_process');
const { once }=require('node:events');
const { writeStatus }=require('../server/service-status');

test('Caddy serves stopped and restarting messages with readable CORS responses while Node is off',async t=>{
  try{await fs.access('/usr/bin/caddy');}catch{return t.skip('Caddy is not installed');}
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'wedding-status-'));
  const previous=process.env.WEDDING_STATUS_DIR;
  process.env.WEDDING_STATUS_DIR=path.join(dir,'status');
  let child;
  t.after(async()=>{
    if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited;}
    if(previous===undefined)delete process.env.WEDDING_STATUS_DIR;else process.env.WEDDING_STATUS_DIR=previous;
    await fs.rm(dir,{recursive:true,force:true});
  });
  const reserve=async()=>{
    const server=require('node:net').createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
  };
  const port=await reserve();const dead=await reserve();
  await writeStatus('stopped');
  const example=await fs.readFile(path.join(__dirname,'..','Caddyfile.example'),'utf8');
  const errors=example.slice(example.indexOf('    handle_errors'),example.lastIndexOf('}')).replaceAll('/home/nick/Desktop/Projects/wedding_photos_site/.runtime/public-status',process.env.WEDDING_STATUS_DIR);
  const file=path.join(dir,'Caddyfile');
  await fs.writeFile(file,`{\n admin off\n auto_https off\n}\nhttp://127.0.0.1:${port} {\n reverse_proxy 127.0.0.1:${dead}\n${errors}\n}\n`);
  let logs='';
  child=spawn('/usr/bin/caddy',['run','--config',file,'--adapter','caddyfile'],{stdio:['ignore','ignore','pipe']});child.stderr.on('data',data=>logs+=data);
  const base=`http://127.0.0.1:${port}`;
  let response;
  for(let count=0;count<100;count++){
    try{response=await fetch(base+'/api/config',{headers:{Origin:'https://agostonicholas.github.io'}});break;}catch{}
    if(child.exitCode!==null)assert.fail(logs);
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.ok(response,logs);assert.equal(response.status,503);
  assert.equal(response.headers.get('access-control-allow-origin'),'https://agostonicholas.github.io');
  assert.equal((await response.json()).error,'Service not running right now -Nick');
  const html=await fetch(base+'/');assert.equal(html.status,503);assert.match(await html.text(),/Service not running right now -Nick/);
  const preflight=await fetch(base+'/upload',{method:'OPTIONS',headers:{Origin:'https://agostonicholas.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'x-wedding-device'}});
  assert.equal(preflight.status,204);assert.match(preflight.headers.get('access-control-allow-headers'),/X-Wedding-Device/);
  await writeStatus('restarting');
  const restart=await fetch(base+'/api/config');assert.equal(restart.status,503);assert.equal((await restart.json()).error,'Service is restarting -Nick');
});

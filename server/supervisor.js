// A restart stays inside this fixed app; web requests never execute shell commands.
const { fork } = require('node:child_process');
const path = require('node:path');
const { writeStatus } = require('./service-status');
let worker;
let requestedAction = null;
let shuttingDown = false;
async function launch() {
  await writeStatus('restarting');
  worker = fork(path.join(__dirname, 'index.js'), [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
  worker.on('message', message => {
    if (message?.type === 'ready') {
      writeStatus('stopped').catch(error => console.error(error.message));
      return;
    }
    if (message?.type !== 'admin-control' || !['restart', 'stop'].includes(message.action) || requestedAction) return;
    requestedAction = message.action;
    writeStatus(message.action === 'restart' ? 'restarting' : 'stopped').catch(error => console.error(error.message)).finally(() => {
      if (worker.connected) worker.send({ type: 'graceful-shutdown' });
    });
  });
  worker.once('error', error => { console.error(error.message); process.exitCode = 1; });
  worker.once('exit', async (code, signal) => {
    if (requestedAction === 'restart' && !shuttingDown) {
      requestedAction = null;
      console.log('Restarting wedding photo server…');
      launch().catch(failed);
    } else {
      try { await writeStatus('stopped'); } catch (error) { console.error(error.message); }
      process.exitCode = shuttingDown || requestedAction === 'stop' ? 0 : (code || (signal ? 1 : 0));
    }
  });
}
function failed(error) { console.error(error.message); process.exitCode = 1; }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (shuttingDown) return;
  shuttingDown = true;
  writeStatus('stopped').then(() => {
    if (worker?.connected) worker.send({ type: 'graceful-shutdown' });
  }).catch(failed);
});
launch().catch(failed);

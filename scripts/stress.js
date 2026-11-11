#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
require('dotenv').config({ quiet: true, path: path.resolve(__dirname, '..', '.env') });
const BASE_URL = (process.env.BASE_URL || 'http://127.0.0.1:4000').replace(/\/$/, '');
function count(key, fallback, minimum = 1) {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${key} must be an integer >= ${minimum}.`);
  return value;
}
const cookies = new Map();
async function request(url, options = {}) {
  const response = await fetch(BASE_URL + url, { ...options, headers: { cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...options.headers } });
  for (const cookie of response.headers.getSetCookie()) {
    const value = cookie.split(';')[0];
    const separator = value.indexOf('=');
    cookies.set(value.slice(0, separator), value.slice(separator + 1));
  }
  const body = await response.text();
  if (!response.ok) throw new Error(`${url}: ${response.status} ${body}`);
  return body;
}
async function pool(tasks, concurrency, worker) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) await worker(tasks[cursor++]);
  }));
}
function summary(samples) {
  if (!samples.length) return 'no successful samples';
  const sorted = [...samples].sort((a, b) => a - b);
  return `avg ${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)}ms | p95 ${sorted[Math.floor((sorted.length - 1) * .95)].toFixed(1)}ms | max ${sorted.at(-1).toFixed(1)}ms`;
}
async function main() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE_URL).hostname) && process.env.STRESS_ALLOW_REMOTE !== 'true') throw new Error('Stress testing defaults to local servers. Set STRESS_ALLOW_REMOTE=true explicitly for another host.');
  const uploads = count('STRESS_UPLOADS', 20, 0);
  const browsing = count('STRESS_BROWSE', 200, 0);
  const concurrency = count('STRESS_CONCURRENCY', 5);
  const ratio = Number(process.env.STRESS_VIDEO_RATIO || 0);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new Error('STRESS_VIDEO_RATIO must be between 0 and 1.');
  if (ratio && !process.env.STRESS_VIDEO) throw new Error('Set STRESS_VIDEO to a real MP4 file when testing videos.');
  const image = process.env.STRESS_IMAGE ? fs.readFileSync(process.env.STRESS_IMAGE) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOxoAAAAASUVORK5CYII=', 'base64');
  const imageName = process.env.STRESS_IMAGE ? path.basename(process.env.STRESS_IMAGE) : 'stress.png';
  const video = ratio ? fs.readFileSync(process.env.STRESS_VIDEO) : null;
  await request('/session/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: process.env.STRESS_ACCESS_CODE || process.env.ACCESS_CODE || '' }) });
  let failures = 0;
  for (const [name, tasks] of [['uploads', Array.from({ length: uploads })], ['browse', Array.from({ length: browsing }, (_, index) => ['/api/recent', '/api/gallery?limit=60', '/album'][index % 3])]]) {
    const samples = [];
    await pool(tasks, concurrency, async endpoint => {
      const start = performance.now();
      try {
        if (name === 'uploads') {
          const form = new FormData();
          const useVideo = video && Math.random() < ratio;
          form.append('photos', new Blob([useVideo ? video : image], { type: useVideo ? 'video/mp4' : 'image/png' }), useVideo ? 'stress.mp4' : imageName);
          form.append('uploaderName', 'Stress Tester');
          await request('/upload', { method: 'POST', headers: {}, body: form });
        } else await request(endpoint);
        samples.push(performance.now() - start);
      } catch (error) { failures++; console.error('[stress]', error.message); }
    });
    console.log(`[stress] ${name}: ${samples.length}/${tasks.length} succeeded | ${summary(samples)}`);
  }
  if (failures) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

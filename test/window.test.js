'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { once } = require('events');

// window.js reads its paths at require time, so the state dir has to be set first.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "peek win's café-"));
process.env.PEEK_STATE_DIR = TMP;
const win = require('../src/window');
const { browserProfile, browserStatePath } = require('../src/config');


test('macOS candidates include all expected browser locations', () => {
  const paths = win.candidates('darwin', '/Users/test');

  const expected = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
    '/Users/test/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/test/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Users/test/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Users/test/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Users/test/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  ];

  assert.deepEqual(paths, expected);
});

test('Windows candidates include all expected browser locations', () => {
  const env = {
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  };

  const paths = win.candidates('win32', 'C:\\Users\\test', env);
  const roots = [
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.LOCALAPPDATA,
  ];

  const browsers = [
    'Google\\Chrome\\Application\\chrome.exe',
    'Chromium\\Application\\chrome.exe',
    'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    'Microsoft\\Edge\\Application\\msedge.exe',
    'Google\\Chrome Beta\\Application\\chrome.exe',
    'Google\\Chrome Dev\\Application\\chrome.exe',
    'Google\\Chrome SxS\\Application\\chrome.exe',
    'Vivaldi\\Application\\vivaldi.exe',
  ];

  const expected = roots.flatMap((root) =>
    browsers.map((browser) => path.win32.join(root, browser))
  );

  assert.deepEqual(paths, expected);
});

test('Linux candidates include all expected browser locations', () => {
  const paths = win.candidates('linux', '/home/test');

  const expected = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    'google-chrome',
    'chromium',
    'brave-browser',
    'microsoft-edge',
    '/usr/bin/vivaldi-stable',
    '/usr/bin/microsoft-edge-stable',
    '/home/test/.local/share/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/com.brave.Browser',
  ];

  assert.deepEqual(paths, expected);
});


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Stands in for the preview server: `clients` is the only field that matters.
let server;
let port;
let clients = 0;

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, clients }));
    }
    if (req.url === '/old') {
      // a server from before /health reported a client count
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('a connected page means a window is on screen', async () => {
  clients = 1;
  assert.equal(await win.windowConnected(port, 0), true);
});

test('no connected page means no window, whatever the browser process is doing', async () => {
  clients = 0;
  assert.equal(await win.windowConnected(port, 0), false);
});

test('a page that connects during the grace period counts', async () => {
  clients = 0;
  setTimeout(() => (clients = 1), 300);
  const t0 = Date.now();
  assert.equal(await win.windowConnected(port, 2000), true);
  assert.ok(Date.now() - t0 < 2000, 'returned as soon as the page appeared');
});

test('an unreachable server is "cannot tell", not "no window"', async () => {
  // port 1 is not listening; null keeps the caller from closing a live window
  assert.equal(await win.windowConnected(1, 0), null);
});

test('a server too old to report a count is also "cannot tell"', async () => {
  const old = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pid: 1, docs: 0 }));
  });
  await new Promise((r) => old.listen(0, '127.0.0.1', r));
  assert.equal(await win.windowConnected(old.address().port, 0), null);
  old.close();
});

test('ours() tells peek\'s browser from a recycled pid', async () => {
  const mine = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)', browserProfile], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  const theirs = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  mine.unref();
  theirs.unref();
  await sleep(400);

  try {
    assert.equal(win.ours(mine.pid), true, 'a process running out of the peek profile');
    assert.equal(win.ours(theirs.pid), false, 'an unrelated process that inherited the pid');
    assert.ok(win.profilePids().includes(mine.pid), 'the sweep finds it');
    assert.ok(!win.profilePids().includes(theirs.pid), 'and only it');

    await win.terminate(mine.pid);
    await sleep(200);
    assert.ok(!win.profilePids().includes(mine.pid), 'terminate() reaps it');
  } finally {
    for (const c of [mine, theirs]) {
      try {
        c.kill('SIGKILL');
      } catch (_) {}
    }
  }
});

test('close finds the profile browser without signalling a recycled pid or a helper', { timeout: 15000 }, async (t) => {
  async function child(args) {
    const proc = spawn(process.execPath, ['-e', 'process.send("ready"); setInterval(()=>{},1e9)', ...args], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true,
    });
    t.after(() => { proc.kill('SIGKILL'); });
    await once(proc, 'message');
    proc.disconnect();
    return proc;
  }
  const browser = await child([browserProfile]);
  const helper = await child([browserProfile, '--type=renderer']);
  const unrelated = await child([]);
  fs.writeFileSync(browserStatePath, JSON.stringify({ pid: unrelated.pid }));
  const closed = once(browser, 'exit');

  win.close();

  await closed;
  assert.ok(win.alive(unrelated.pid), 'the unrelated process behind the recorded pid survives');
  assert.ok(win.alive(helper.pid), 'helpers are not selected as the browser process');
  assert.equal(fs.existsSync(browserStatePath), false);
});

test('a dead pid is never signalled', () => {
  assert.equal(win.ours(0), false);
  assert.equal(win.alive(0), false);
});

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile, execFileSync } = require('child_process');
const { browserStatePath, browserProfile, launchLockPath, STATE_DIR, userConfigPath } = require('./config');

const PLATFORM = process.platform;

/* --------------------------------------------------- finding a browser */

// Chromium-family browsers are the ones that support --app=, which is what
// turns a page into a real window with no tabs or address bar.
function candidates(platform = PLATFORM, homeDir = os.homedir(), env = process.env) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
      platformPath.join(homeDir, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      platformPath.join(homeDir, 'Applications/Chromium.app/Contents/MacOS/Chromium'),
      platformPath.join(homeDir, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      platformPath.join(homeDir, 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      platformPath.join(homeDir, 'Applications/Vivaldi.app/Contents/MacOS/Vivaldi'),
    ];
  }

  if (platform === 'win32') {
    const roots = [
      env['PROGRAMFILES'],
      env['PROGRAMFILES(X86)'],
      env['LOCALAPPDATA'],
    ].filter(Boolean);
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'Google\\Chrome Beta\\Application\\chrome.exe',
      'Google\\Chrome Dev\\Application\\chrome.exe',
      'Google\\Chrome SxS\\Application\\chrome.exe',
      'Vivaldi\\Application\\vivaldi.exe',
    ];
    return roots.flatMap((r) => rel.map((x) => platformPath.join(r, x)));
  }

  // Linux and the BSDs: absolute paths first, then bare names resolved on PATH.
  return [
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
    platformPath.join(homeDir, '.local/share/flatpak/exports/bin/com.google.Chrome'),
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    '/var/lib/flatpak/exports/bin/com.brave.Browser',
  ];
}

function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      fs.accessSync(path.join(d, name), fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

function findBrowser() {
  for (const c of candidates()) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else if (onPath(c)) {
      return c;
    }
  }
  return null;
}

/* ------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// Windows quotes and backslashes determine argument boundaries. Match the whole
// profile argument so a sibling profile with the same prefix is never ours.
// https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
function windowsArguments(command) {
  const args = [];
  let argument = '';
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    let slashes = 0;
    while (command[i] === '\\') {
      slashes++;
      i++;
    }
    if (command[i] === '"') {
      argument += '\\'.repeat(Math.floor(slashes / 2));
      if (slashes % 2) {
        argument += '"';
      } else if (quoted && command[i + 1] === '"') {
        argument += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else {
      argument += '\\'.repeat(slashes);
      if (i === command.length || (!quoted && /[ \t]/.test(command[i]))) {
        if (argument) args.push(argument);
        argument = '';
      } else {
        argument += command[i];
      }
    }
  }
  if (argument) args.push(argument);
  return args;
}

// Query only profile-matching command lines, without interpolating the profile
// path into PowerShell code. An unavailable query must leave processes alone.
function windowsProfileProcesses() {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
      '$ErrorActionPreference = "Stop"; ' +
      'Get-CimInstance Win32_Process | ' +
      'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:PEEK_BROWSER_PROFILE) } | ' +
      'Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress',
    ], {
      encoding: 'utf8', windowsHide: true, timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PEEK_BROWSER_PROFILE: browserProfile },
    });
    const rows = JSON.parse(out.replace(/^\uFEFF/, ''));
    return (Array.isArray(rows) ? rows : [rows]).filter((p) =>
      p && Number.isInteger(p.ProcessId) && p.ProcessId > 0 && p.ProcessId !== process.pid &&
      typeof p.CommandLine === 'string' && windowsArguments(p.CommandLine).slice(1).some((arg) =>
        arg === browserProfile || arg === `--user-data-dir=${browserProfile}`
      )
    );
  } catch (_) {
    return [];
  }
}

// pids are recycled, so a live pid is not proof it is still our browser. Check
// the command line before signalling it rather than trust the recorded number.
function ours(pid) {
  if (!alive(pid)) return false;
  if (PLATFORM === 'win32') return windowsProfileProcesses().some((p) => p.ProcessId === pid);
  try {
    const cmd = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cmd.includes(browserProfile);
  } catch (_) {
    return false;
  }
}

// Every browser process running out of peek's profile. Chrome hands a second
// `--app=` launch to the instance that already owns the profile and the process
// that was spawned exits at once, so the pid in browser.json can be a launcher
// that is long gone while the window it opened is still up. Asking the process
// table sidesteps that bookkeeping entirely. Helper processes carry --type=;
// the browser itself does not, and killing it takes its helpers with it.
function profilePids() {
  if (PLATFORM === 'win32') {
    return windowsProfileProcesses()
      .filter((p) => !p.CommandLine.includes('--type='))
      .map((p) => p.ProcessId);
  }
  try {
    const out = execFileSync('ps', ['-ww', '-Ao', 'pid=,command='], { encoding: 'utf8' });
    return out
      .split('\n')
      .filter((l) => l.includes(browserProfile) && !l.includes('--type='))
      .map((l) => Number(l.trim().split(/\s+/)[0]))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch (_) {
    return [];
  }
}

// SIGTERM, then wait for the process to actually go: it holds the singleton
// lock on the browser profile, and a new window cannot own that profile until
// the lock is released.
async function terminate(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (_) {
    return;
  }
  const deadline = Date.now() + 2000;
  while (alive(pid) && Date.now() < deadline) await sleep(100);
  if (alive(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (_) {}
  }
  await sleep(150);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(browserStatePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function userConfig() {
  try {
    return JSON.parse(fs.readFileSync(userConfigPath, 'utf8'));
  } catch (_) {
    return {};
  }
}

// Hands a URL or path to whatever the desktop has registered for it.
function openExternally(target) {
  if (PLATFORM === 'darwin') return execFile('open', [target], () => {});
  if (PLATFORM === 'win32') return execFile('cmd', ['/c', 'start', '', target], () => {});
  return execFile('xdg-open', [target], () => {});
}

// Shows a file in Finder / Explorer / the desktop's file manager.
function reveal(file) {
  if (PLATFORM === 'darwin') return execFile('open', ['-R', file], () => {});
  if (PLATFORM === 'win32') return execFile('explorer', [`/select,${file}`], () => {});
  return execFile('xdg-open', [path.dirname(file)], () => {});
}

/* ------------------------------------------------------------ the window */

// Raising an existing window means talking to the window server, which macOS
// gates behind an Automation/Accessibility prompt. It is off by default: a
// live-updating window that does not steal focus needs no permissions at all.
// Set "focusWindow": true in the config to opt in. Only implemented on macOS.
function focus(pid) {
  if (PLATFORM !== 'darwin' || userConfig().focusWindow !== true) return false;
  execFile(
    'osascript',
    [
      '-e',
      `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
    ],
    () => {}
  );
  return true;
}

function launch(url, { width = 1080, height = 1180 } = {}) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const bin = findBrowser();

  if (!bin) {
    // No Chromium-family browser: an ordinary tab in the default browser still
    // gives a working preview, just without the dedicated-window feel.
    openExternally(url);
    fs.writeFileSync(browserStatePath, JSON.stringify({ pid: null, url, mode: 'default-browser', at: Date.now() }));
    return { mode: 'default-browser' };
  }

  const child = spawn(
    bin,
    [
      `--app=${url}`,
      `--user-data-dir=${browserProfile}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--no-service-autorun',
      '--password-store=basic',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();

  fs.writeFileSync(
    browserStatePath,
    JSON.stringify({ pid: child.pid, url, mode: 'app-window', browser: path.basename(bin), at: Date.now() })
  );
  return { mode: 'app-window', pid: child.pid, browser: path.basename(bin) };
}

// Whether a window is actually on screen, asked of the server rather than the
// operating system: the page holds an SSE connection open for as long as it is
// loaded, so a connected client is a window and no connected client is not.
//
// A live browser process is NOT the same question. Close the preview window on
// macOS and Chrome stays running with no windows at all — it will happily sit
// there for hours — so a pid check reports "already open" for a window that
// vanished long ago, and nothing ever opens again.
//
// Returns null when the server cannot answer, or is too old to report a count:
// the caller must then leave the existing window alone rather than guess.
async function windowConnected(port, waitMs) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    let h = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(700) });
      if (res.ok) h = await res.json();
    } catch (_) {}
    if (!h || typeof h.clients !== 'number') return null;
    if (h.clients > 0) return true;
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
}

// Parallel tool calls fire parallel hooks, and two runs that both decide to
// launch produce two windows. Only the holder of this lock opens one; the other
// waits for the window already on its way.
function claimLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  try {
    fs.writeFileSync(launchLockPath, String(process.pid), { flag: 'wx' });
    return true;
  } catch (_) {}
  try {
    // A lock left behind by a run that died must not wedge the window shut.
    if (Date.now() - fs.statSync(launchLockPath).mtimeMs > 20_000) {
      fs.unlinkSync(launchLockPath);
      fs.writeFileSync(launchLockPath, String(process.pid), { flag: 'wx' });
      return true;
    }
  } catch (_) {}
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(launchLockPath);
  } catch (_) {}
}

async function openWindow(url, port, sweep) {
  if (!claimLock()) {
    const up = await windowConnected(port, 5000);
    return { mode: up ? 'already open' : 'launching' };
  }
  try {
    // Nothing is on screen, so any browser still running out of the profile is
    // a leftover — and it holds the profile's lock, which a new window needs.
    if (sweep) for (const p of profilePids()) await terminate(p);
    return launch(url);
  } finally {
    releaseLock();
  }
}

// Opens the preview window if one is not already on screen. A window that is
// still up is left where it is — its content updates over SSE without stealing
// focus.
async function ensure(url, port) {
  const st = readState();
  const pid = ours(st.pid) ? st.pid : null;
  const recent = st.at && Date.now() - st.at < 10_000;

  // Give a window that plausibly exists time to (re)connect before writing it
  // off: the page retries every 1.5s, so a server that restarted underneath a
  // perfectly good window must not be mistaken for a closed one.
  const connected = await windowConnected(port, pid || recent ? 2500 : 0);

  if (connected === null) {
    // No usable answer. Fall back to the old pid-shaped guess and do nothing
    // destructive on the strength of it.
    if (pid) return { mode: focus(pid) ? 'focused' : 'already open', pid };
    if (st.mode === 'default-browser') return { mode: 'default-browser' };
    return openWindow(url, port, false);
  }

  if (connected) {
    if (st.mode === 'default-browser') return { mode: 'default-browser' };
    // browser.json may name a launcher that has since exited; the process table
    // still knows which browser is holding the window up.
    const target = pid || profilePids()[0];
    if (!target) return { mode: 'already open' };
    return { mode: focus(target) ? 'focused' : 'already open', pid: target };
  }

  // Nothing is listening, so there is no window — whatever browser.json says.
  return openWindow(url, port, true);
}

function close() {
  const st = readState();
  const pids = new Set(profilePids());
  if (ours(st.pid)) pids.add(st.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (_) {}
  }
  try {
    fs.unlinkSync(browserStatePath);
  } catch (_) {}
}

module.exports = {
  candidates,
  ensure,
  launch,
  focus,
  close,
  alive,
  ours,
  terminate,
  profilePids,
  findBrowser,
  reveal,
  readState,
  windowConnected,
};

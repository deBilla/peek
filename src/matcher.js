'use strict';

const fs = require('fs');
const path = require('path');
const { userConfigPath, STATE_DIR } = require('./config');

const DEFAULTS = {
  enabled: true,
  // Raise the window on update. Off by default: macOS asks for Automation/
  // Accessibility permission the first time, and a silent live update is usually
  // what you want while you are still typing in the terminal. macOS only.
  focusWindow: false,
  // Any of these as a whole word in the file name (case-insensitive) marks it
  // as a plan.
  filenamePatterns: [
    'plan', 'design', 'proposal', 'rfc', 'spec', 'roadmap',
    'architecture', 'migration', 'implementation', 'todo', 'tasks', 'checklist',
  ],
  // Any of these substrings in the absolute path marks it as a plan.
  pathPatterns: ['/scratchpad/', '/.claude/plans/', '/docs/plans/'],
  // Or a top-level heading in the first part of the document that reads like one.
  headingPattern:
    '^#{1,2}\\s+.*\\b(plan|proposal|design|rfc|spec|roadmap|architecture|migration|implementation|approach)\\b',
  // Never preview these, whatever else matches.
  excludePatterns: ['node_modules/', '/CLAUDE.md', 'README', 'CHANGELOG', 'LICENSE', 'CONTRIBUTING'],
  // Ignore stubs — a two-line file is not a plan worth a window.
  minBytes: 200,
};

// Reads the user's config, writing the defaults out the first time so there is
// something to edit. Unknown keys are preserved; missing ones fall back.
function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(userConfigPath, 'utf8')) };
  } catch (_) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(userConfigPath, JSON.stringify(DEFAULTS, null, 2) + '\n');
    } catch (_) {}
    return DEFAULTS;
  }
}

// Split a name into lowercase words on `-`, `_`, `.`, space and camelCase
// humps: `rollout-plan.md` becomes ['rollout', 'plan', 'md'] and `designDoc.md`
// becomes ['design', 'doc', 'md']. Splitting before lowercasing is what keeps
// the camelCase boundary visible.
function nameWords(name) {
  return name
    .split(/[\s._-]+/)
    .flatMap((part) => part.replace(/([a-z\d])([A-Z])/g, '$1 $2').split(' '))
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

// A pattern matches when its own words appear as one unbroken run in the
// name's words. Every default pattern is a single word, so this reduces to
// whole-word equality — `plan` hits `rollout-plan.md` but not `inspect.md` —
// while a multi-word pattern like `my-plan` still matches across separators.
function matchesName(words, pattern) {
  const wanted = nameWords(pattern);
  if (wanted.length === 0) return false;
  for (let at = 0; at + wanted.length <= words.length; at += 1) {
    if (wanted.every((word, i) => words[at + i] === word)) return true;
  }
  return false;
}

// Decides whether a written file is a plan worth putting on screen. Kept pure
// apart from reading the file itself, so it is straightforward to test.
function isPlan(file, cfg = DEFAULTS) {
  const abs = path.resolve(file);
  if (!/\.(md|markdown)$/i.test(abs)) return false;

  const lower = abs.toLowerCase();
  // An exclude pattern written with a `/` is path-style and is tested
  // against the whole absolute path, as before (`node_modules/`,
  // `/CLAUDE.md`). A pattern without a `/` is filename-style and is
  // tested against the basename only: `README` excludes `README.md`,
  // but no longer a whole `readme-assets/` directory (issue #2).
  const base = path.basename(lower);
  if (cfg.excludePatterns.some((p) => {
    const want = p.toLowerCase();
    return want.includes('/') ? lower.includes(want) : base.includes(want);
  })) return false;

  let st;
  try {
    st = fs.statSync(abs);
  } catch (_) {
    return false; // the edit did not land
  }
  if (!st.isFile() || st.size < cfg.minBytes) return false;

  const words = nameWords(path.basename(abs));
  if (cfg.filenamePatterns.some((p) => matchesName(words, p))) return true;

  // Path patterns are written with forward slashes; normalise for Windows.
  const posix = abs.split(path.sep).join('/');
  if (cfg.pathPatterns.some((p) => posix.includes(p))) return true;

  try {
    const head = fs.readFileSync(abs, 'utf8').slice(0, 4000);
    if (new RegExp(cfg.headingPattern, 'im').test(head)) return true;
  } catch (_) {}

  return false;
}

module.exports = { isPlan, loadConfig, DEFAULTS };

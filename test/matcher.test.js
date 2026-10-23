'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isPlan, DEFAULTS } = require('../src/matcher');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-test-'));
const PAD = 'x'.repeat(400); // clears the minBytes floor

function write(name, body) {
  const p = path.join(DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

test('matches on a plan-ish filename', () => {
  assert.ok(isPlan(write('rollout-plan.md', `# Anything\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('API-DESIGN.md', `# Anything\n\n${PAD}`), DEFAULTS));
});

test('matches filename patterns across separators and camelCase', () => {
  assert.ok(isPlan(write('rollout-plan.md', `# Anything\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('PLAN.md', `# Anything\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('designDoc.md', `# Anything\n\n${PAD}`), DEFAULTS));
});

test('does not match a filename pattern inside a longer word', () => {
  assert.equal(isPlan(write('inspect-notes.md', `# Anything\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('planets.md', `# Anything\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('respect.md', `# Anything\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('redesigned-logo.md', `# Anything\n\n${PAD}`), DEFAULTS), false);
});

test('matches on a plan-ish heading even with a neutral filename', () => {
  assert.ok(isPlan(write('notes.md', `# Migration approach\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('scratch.md', `## Implementation plan\n\n${PAD}`), DEFAULTS));
});

test('matches on a plan-ish path', () => {
  assert.ok(isPlan(write('docs/plans/thing.md', `# Thing\n\n${PAD}`), DEFAULTS));
});

test('ignores ordinary markdown', () => {
  assert.equal(isPlan(write('notes.md', `# Meeting notes\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('journal.md', `# Tuesday\n\n${PAD}`), DEFAULTS), false);
});

test('ignores excluded files however they are named', () => {
  assert.equal(isPlan(write('README.md', `# Project plan\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('CHANGELOG.md', `# Roadmap\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('node_modules/pkg/plan.md', `# Plan\n\n${PAD}`), DEFAULTS), false);
});

test('ignores non-markdown files', () => {
  assert.equal(isPlan(write('plan.txt', `# Plan\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('plan.js', `// plan\n${PAD}`), DEFAULTS), false);
});

test('ignores stubs below the size floor', () => {
  assert.equal(isPlan(write('tiny-plan.md', '# Plan\n'), DEFAULTS), false);
});

test('ignores files that do not exist', () => {
  assert.equal(isPlan(path.join(DIR, 'ghost-plan.md'), DEFAULTS), false);
});

test('honours a caller-supplied config', () => {
  const strict = { ...DEFAULTS, filenamePatterns: ['blueprint'], pathPatterns: [], headingPattern: 'zzz' };
  assert.ok(isPlan(write('blueprint.md', `# X\n\n${PAD}`), strict));
  assert.equal(isPlan(write('plan.md', `# X\n\n${PAD}`), strict), false);
});

test('matches a multi-word filename pattern across separators', () => {
  const cfg = { ...DEFAULTS, filenamePatterns: ['my-plan'], pathPatterns: [], headingPattern: 'zzz' };
  assert.ok(isPlan(write('my-plan.md', `# X\n\n${PAD}`), cfg));
  assert.ok(isPlan(write('myPlan.md', `# X\n\n${PAD}`), cfg));
  assert.equal(isPlan(write('your-plan.md', `# X\n\n${PAD}`), cfg), false);
});

test('treats an empty filename pattern as matching nothing', () => {
  const cfg = { ...DEFAULTS, filenamePatterns: [''], pathPatterns: [], headingPattern: 'zzz' };
  assert.equal(isPlan(write('anything.md', `# X\n\n${PAD}`), cfg), false);
});

test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

test('a filename-style exclude does not exclude a matching directory', () => {
  // issue #2: `README` is filename-style, so a plan under `readme-assets/`
  // is previewed instead of being excluded by the directory's name.
  assert.ok(isPlan(write('readme-assets/rollout-plan.md', `# Anything\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('changelog-stuff/design.md', `# Anything\n\n${PAD}`), DEFAULTS));
  assert.ok(isPlan(write('license-templates/proposal.md', `# Anything\n\n${PAD}`), DEFAULTS));
});

test('a filename-style exclude still excludes the file it names', () => {
  assert.equal(isPlan(write('README.md', `# Project plan\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('readme-notes.md', `# Project plan\n\n${PAD}`), DEFAULTS), false);
});

test('a path-style exclude keeps matching the whole path', () => {
  assert.equal(isPlan(write('node_modules/pkg/plan.md', `# Plan\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('CLAUDE.md', `# Plan\n\n${PAD}`), DEFAULTS), false);
  assert.equal(isPlan(write('sub/CLAUDE.md', `# Plan\n\n${PAD}`), DEFAULTS), false);
});

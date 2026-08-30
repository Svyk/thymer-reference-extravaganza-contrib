'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const contract = fs.readFileSync(path.join(root, 'docs', 'LINE-ALIAS-SURFACE-V1.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'docs', 'LINE-ALIASES-ROADMAP.md'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'line-alias-surface-v1.json'), 'utf8'));

test('L0 fixture freezes every required line-alias edge class', () => {
  const ids = new Set(fixture.cases.map((item) => item.id));
  for (const id of [
    'multiple-aliases-one-line', 'line-line-collision-a', 'line-line-collision-b',
    'record-line-same-text-not-collision', 'edit-retains-guid', 'move-retains-guid',
    'deleted-tombstone', 'undeleted-target', 'unicode-nfc',
    'whitespace-case-dedup', 'unknown-cold-target', 'rich-ref-title-rewrite',
  ]) assert.ok(ids.has(id), 'missing fixture ' + id);
});

test('L0 contract keeps record and line namespaces separate and freezes no-scan safety', () => {
  assert.match(contract, /existing\s+record-only\s+`aliases`\s+surface\s+is\s+unchanged/i);
  assert.match(contract, /Record aliases and line aliases are separate namespaces/i);
  assert.match(contract, /No workspace-wide line scan is introduced/i);
  assert.match(contract, /Event handlers are payload-first and perform no `data\.getRecord\(\)` call/i);
  assert.match(contract, /supportsLineAliases:\s*true/);
  assert.match(contract, /lineAliases:\s*\{/);
});

test('L0 roadmap traces all LC1-LC14 requirements and release gates', () => {
  for (let i = 1; i <= 14; i++) assert.match(roadmap, new RegExp('\\| LC' + i + ' \\|'));
  assert.match(roadmap, /Reference Extravaganza `4\.0\.0`/);
  assert.match(roadmap, /Backreferences `0\.29\.0`/);
  assert.match(roadmap, /Reference Graph `0\.7\.0`/);
});

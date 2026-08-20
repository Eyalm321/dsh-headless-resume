import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndex, writeIndex, lookup, record, forget, defaultKey } from '../src/sessionIndex.js';

const fresh = () => join(mkdtempSync(join(tmpdir(), 'dhr-')), 'nested', 'session-index.json');

test('a missing index reads as empty rather than throwing', () => {
  assert.deepEqual(readIndex(fresh()), {});
});

test('a corrupt index reads as empty so one bad file cannot strand a run', () => {
  const p = fresh();
  writeIndex(p, {});
  writeFileSync(p, '{ not json');
  assert.deepEqual(readIndex(p), {});
});

test('a JSON array is rejected as a shape, not accepted as an object', () => {
  const p = fresh();
  writeIndex(p, {});
  writeFileSync(p, '["nope"]');
  assert.deepEqual(readIndex(p), {});
});

test('record creates missing parent directories', () => {
  const p = fresh();
  record(p, 'canora', 'session-1');
  assert.equal(lookup(p, 'canora'), 'session-1');
});

test('record preserves other threads', () => {
  const p = fresh();
  record(p, 'canora', 'session-1');
  record(p, 'tooling', 'session-2');
  record(p, 'canora', 'session-3');
  assert.equal(lookup(p, 'canora'), 'session-3');
  assert.equal(lookup(p, 'tooling'), 'session-2');
});

test('lookup of an unknown or empty key is undefined', () => {
  const p = fresh();
  record(p, 'canora', '');
  assert.equal(lookup(p, 'canora'), undefined);
  assert.equal(lookup(p, 'absent'), undefined);
});

test('forget removes only its own key', () => {
  const p = fresh();
  record(p, 'a', 's1');
  record(p, 'b', 's2');
  forget(p, 'a');
  assert.equal(lookup(p, 'a'), undefined);
  assert.equal(lookup(p, 'b'), 's2');
});

test('the written file is valid JSON on disk', () => {
  const p = fresh();
  record(p, 'k', 'session-9');
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { k: 'session-9' });
});

test('the default key is derived from cwd', () => {
  assert.equal(defaultKey('/home/x/dev'), 'cwd:/home/x/dev');
});

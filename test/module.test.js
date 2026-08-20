import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing the entrypoint is the point of this file: the unit tests above exercise
// harness-free modules, so without this a syntax or bad-import error in index.js
// would ship green.
test('the plugin module loads and exports the Cordis surface', async () => {
  const mod = await import('../src/index.js');
  assert.equal(mod.name, 'headless-resume-runner');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject));
  for (const service of ['agentDefaultModel', 'agents', 'sessions']) {
    assert.ok(mod.inject.includes(service), `inject must contain ${service}`);
  }
  assert.ok(mod.Config, 'Config schema must be exported');
});

test('apply refuses to mount without the launcher exit hook', async () => {
  const { apply } = await import('../src/index.js');
  const ctx = { get: () => undefined };
  assert.throws(() => apply(ctx, { task: 't' }), /must provide ctx\.appExit/);
});

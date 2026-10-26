/**
 * A dispatched agent is a child session, or it is invisible.
 *
 * The header fields already exist; what was missing is anyone supplying them for an agent that
 * runs as its own process. subagent.list finds children by scanning headers for
 * `parentSession`, so getting these three fields right is the whole difference between an
 * agent the parent conversation can show and one nothing knows about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineageMeta, parentDepthOf, acquireAgent } from '../src/runner.js';

test('no dispatcher means no lineage: an ordinary run stays top-level', () => {
  assert.deepEqual(lineageMeta({ env: {} }), {});
  assert.deepEqual(lineageMeta({ env: { DSH_PARENT_SESSION: '   ' } }), {}, 'whitespace is not a parent');
});

test('a dispatched run records the parent, the origin, and its depth', () => {
  const meta = lineageMeta({ env: { DSH_PARENT_SESSION: 'telegram-42' }, parentDepth: 0 });
  assert.equal(meta.parentSession, 'telegram-42');
  assert.equal(meta.origin, 'subagent');
  assert.equal(meta.delegationDepth, 1);
});

test('a child of a child counts one deeper, so a recursion budget means something', () => {
  assert.equal(lineageMeta({ env: { DSH_PARENT_SESSION: 'p' }, parentDepth: 2 }).delegationDepth, 3);
});

test('an unreadable parent still yields a child, never a top-level session', () => {
  // Guessing 0 would let a dispatched agent claim it was never dispatched.
  assert.equal(lineageMeta({ env: { DSH_PARENT_SESSION: 'p' }, parentDepth: undefined }).delegationDepth, 1);
});

test('the parent depth is read from the store when the parent is there', async () => {
  const persistence = { list: async () => [{ id: 'p1', delegationDepth: 2 }] };
  assert.equal(await parentDepthOf(persistence, 'p1'), 2);
});

test('the parent depth is read from a dsh 0.2 snapshot listing', async () => {
  const persistence = { list: async () => [{ header: { id: 'p1', delegationDepth: 2 }, revision: 'r1' }] };
  assert.equal(await parentDepthOf(persistence, 'p1'), 2);
});

test('a parent absent from the store resolves to unknown rather than zero', async () => {
  const persistence = { list: async () => [{ id: 'other' }] };
  assert.equal(await parentDepthOf(persistence, 'p1'), 0, 'present-but-depthless is depth 0');
  assert.equal(await parentDepthOf({ list: async () => { throw new Error('store down'); } }, 'p1'), undefined);
  assert.equal(await parentDepthOf(undefined, 'p1'), undefined);
});

test('creating a dispatched session passes the lineage to the factory', async () => {
  let seen;
  const agents = {
    create: async (options) => { seen = options; return { agent: { session: {} } }; },
    resume: async () => { throw new Error('should not resume'); },
  };
  const notices = [];
  await acquireAgent({
    agents,
    sessionId: undefined,
    newSessionId: () => 'session-new',
    cwd: '/tmp/x',
    agentOptions: {},
    setup: () => {},
    onNotice: (m) => notices.push(m),
    persistence: { list: async () => [{ id: 'telegram-42', delegationDepth: 0 }] },
    env: { DSH_PARENT_SESSION: 'telegram-42' },
  });
  assert.equal(seen.meta.parentSession, 'telegram-42');
  assert.equal(seen.meta.origin, 'subagent');
  assert.equal(seen.meta.delegationDepth, 1);
  assert.equal(seen.meta.cwd, '/tmp/x', 'cwd is not lost to the merge');
  assert.ok(notices.some((m) => /dispatched by telegram-42/.test(m)), 'the link is reported, not silent');
});

test('an undispatched run creates exactly what it did before', async () => {
  let seen;
  const agents = { create: async (o) => { seen = o; return { agent: { session: {} } }; } };
  await acquireAgent({
    agents, sessionId: undefined, newSessionId: () => 's', cwd: '/tmp/y',
    agentOptions: {}, setup: () => {}, env: {},
  });
  assert.deepEqual(seen.meta, { cwd: '/tmp/y' });
});

test('a dispatched child carries a descriptor, or enumeration calls it corrupt', async () => {
  let seen;
  const agents = { create: async (o) => { seen = o; return { agent: { session: {} } }; } };
  await acquireAgent({
    agents, sessionId: undefined, newSessionId: () => 's', cwd: '/tmp/x',
    agentOptions: { provider: 'claude-cli', model: 'claude-opus-5' }, setup: () => {},
    persistence: { list: async () => [] },
    env: { DSH_PARENT_SESSION: 'p1', DSH_SESSION_KEY: 'project:tooling:repo:widgets' },
  });
  assert.equal(seen.seed.length, 1);
  const d = seen.seed[0];
  assert.equal(d.type, 'subagent/descriptor');
  assert.equal(d.seq, 0, 'a seed must be contiguous from zero');
  assert.equal(d.data.version, 2);
  assert.equal(d.data.mode, 'continuable', 'a dispatched agent keeps its thread');
  assert.equal(d.data.label, 'project:tooling:repo:widgets');
  assert.equal(d.data.agentProvider, 'claude-cli');
  assert.equal(seen.meta.seedLength, 1, 'the boundary between seed and child work');
});

test('an undispatched run gets no descriptor and no seed', async () => {
  let seen;
  const agents = { create: async (o) => { seen = o; return { agent: { session: {} } }; } };
  await acquireAgent({
    agents, sessionId: undefined, newSessionId: () => 's', cwd: '/tmp/y',
    agentOptions: {}, setup: () => {}, env: {},
  });
  assert.equal(seen.seed, undefined);
  assert.equal(seen.meta.seedLength, undefined);
});

test('a label is bounded, so one runaway prompt cannot become the identity', async () => {
  const { descriptorSeed } = await import('../src/runner.js');
  const d = descriptorSeed({ label: 'x'.repeat(400) })[0];
  assert.ok(d.data.label.length <= 120);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireAgent, summarize } from '../src/runner.js';

const agent = (tag) => ({ tag });

test('a recorded session is resumed, not recreated', async () => {
  const calls = [];
  const agents = {
    resume: async (o) => { calls.push(['resume', o.resumeSessionId]); return { agent: agent('r') }; },
    create: async () => { calls.push(['create']); return { agent: agent('c') }; },
  };
  const got = await acquireAgent({ agents, sessionId: 'session-7', newSessionId: () => 'session-new', cwd: '/w' });
  assert.equal(got.resumed, true);
  assert.equal(got.sessionId, 'session-7');
  assert.deepEqual(calls, [['resume', 'session-7']]);
});

test('with no recorded session it creates one and reports it', async () => {
  const agents = {
    resume: async () => { throw new Error('should not be called'); },
    create: async () => ({ agent: agent('c') }),
  };
  const got = await acquireAgent({ agents, sessionId: undefined, newSessionId: () => 'session-new', cwd: '/w' });
  assert.equal(got.resumed, false);
  assert.equal(got.sessionId, 'session-new');
});

test('a failed resume falls back to a fresh session and explains why', async () => {
  const notices = [];
  const agents = {
    resume: async () => { throw new Error('session log missing'); },
    create: async () => ({ agent: agent('c') }),
  };
  const got = await acquireAgent({
    agents, sessionId: 'session-gone', newSessionId: () => 'session-new', cwd: '/w',
    onNotice: (m) => notices.push(m),
  });
  assert.equal(got.resumed, false);
  assert.equal(got.sessionId, 'session-new');
  assert.match(notices[0], /could not resume session-gone/);
  assert.match(notices[0], /session log missing/);
});

test('create receives the working directory as session meta', async () => {
  let seen;
  const agents = { resume: async () => { throw new Error('x'); }, create: async (o) => { seen = o; return { agent: agent('c') }; } };
  await acquireAgent({ agents, sessionId: undefined, newSessionId: () => 's', cwd: '/home/x/dev/canora-sync' });
  assert.equal(seen.meta.cwd, '/home/x/dev/canora-sync');
});

test('summarize ignores events before the interval — a resumed session must not reprint an old answer', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OLD ANSWER' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'completed' } } },
    { seq: 4, type: 'turn/start' },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'NEW ANSWER' }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  assert.equal(summarize(events, 4).text, 'NEW ANSWER');
  assert.equal(summarize(events, 1).text, 'NEW ANSWER');
});

test('summarize keeps the last message and joins only text blocks', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'E', message: 'm' } } } },
  ];
  const out = summarize(events, 1);
  assert.equal(out.text, 'ab');
  assert.equal(out.reason.kind, 'error');
});

test('an empty assistant message does not erase the previous text', () => {
  const events = [
    { seq: 1, type: 'turn/start' },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'kept' }] } } },
    { seq: 3, type: 'assistant/message', data: { message: { content: [{ type: 'tool_use' }] } } },
  ];
  assert.equal(summarize(events, 1).text, 'kept');
});

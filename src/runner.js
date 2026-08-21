/**
 * Harness-free core of the resumable runner.
 *
 * Everything here takes plain collaborators so the resume/create decision — the
 * only part with real behaviour — is testable without booting a harness.
 *
 * @module dsh-headless-resume/runner
 */
import { pruneStaleContext } from './staleContext.js';
import { alignSandboxMode } from './sandboxMode.js';

/**
 * Aggregate the last assistant text and turn outcome from one owned interval.
 *
 * Identical in spirit to the upstream one-shot runner. It matters more here:
 * a resumed session arrives carrying every earlier turn, so bounding the scan
 * at `firstSeq` is what stops the process reprinting an old answer.
 */
export function summarize(events, firstSeq) {
  let started = false;
  let text = '';
  let reason;
  for (const event of events) {
    if (event.seq < firstSeq) continue;
    if (event.type === 'turn/start') { started = true; continue; }
    if (!started) continue;
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (joined !== '') text = joined;
    }
    if (event.type === 'turn/end') reason = event.data.reason;
  }
  return { text, reason };
}


/**
 * The session metadata that makes a dispatched agent a child rather than an orphan.
 *
 * A project agent runs as its own dsh process, so nothing connects it to the conversation that
 * asked for it: the harness files it top-level, `subagent.list` returns nothing for the parent,
 * and a UI cannot show the work it is doing. None of that needs inventing — the session header
 * already persists `parentSession`, `origin` and `delegationDepth`, and the agent factory takes
 * them at creation. They were simply never supplied, because only in-process subagents had a
 * caller that knew the parent.
 *
 * The dispatcher passes DSH_PARENT_SESSION. Depth is the parent's plus one when the parent can be
 * read, and 1 otherwise: an unreadable parent is still a child, and guessing 0 would make a
 * dispatched agent claim to be top-level.
 *
 * @returns {object} meta to merge into the create call
 */
export function lineageMeta({ env = process.env, parentDepth } = {}) {
  const parent = env.DSH_PARENT_SESSION?.trim();
  if (!parent) return {};
  return {
    parentSession: parent,
    origin: 'subagent',
    delegationDepth: Number.isSafeInteger(parentDepth) && parentDepth >= 0 ? parentDepth + 1 : 1,
  };
}

/** The parent's own depth, when its header can be read; undefined when it cannot. */
export async function parentDepthOf(persistence, parentSessionId) {
  if (!persistence || !parentSessionId) return undefined;
  try {
    const found = (await persistence.list()).find((h) => h.id === parentSessionId);
    const depth = found?.delegationDepth ?? found?.header?.delegationDepth;
    return Number.isSafeInteger(depth) ? depth : 0;
  } catch { return undefined; }
}

/**
 * Obtain the agent for this run: resume the recorded session when there is one,
 * otherwise create a fresh session and record it.
 *
 * Resuming is best-effort by design. A recorded session can be deleted, pruned,
 * or written by an incompatible build, and none of those should turn into a
 * failed run — the thread is a convenience, the task is the job. A failed resume
 * therefore falls back to a fresh session and reports why through `onNotice`.
 *
 * @returns {Promise<{agent: object, resumed: boolean, sessionId: string}>}
 */
export async function acquireAgent({ agents, sessionId, newSessionId, cwd, agentOptions, setup, onNotice, persistence, env = process.env }) {
  if (sessionId !== undefined) {
    try {
      const { agent } = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      // A resumed session carries runtime-context snapshots describing PREVIOUS processes
      // (sandbox policy, cwd, model). Drop them so the agent reads the world it is in.
      const notice = { warn: (m) => onNotice?.(m), info: (m) => onNotice?.(m), debug: () => {} };
      pruneStaleContext(agent.session, { log: notice });
      // A session also carries the sandbox mode it was CREATED with, which outranks the
      // deployment default. Realign it, or a session made before the operator set
      // DSH_PERMISSION_MODE stays restricted forever.
      alignSandboxMode(agent.session, process.env.DSH_PERMISSION_MODE, { log: notice });
      return { agent, resumed: true, sessionId };
    } catch (error) {
      onNotice?.(`could not resume ${sessionId} (${error instanceof Error ? error.message : String(error)}); starting a new session`);
    }
  }
  const fresh = newSessionId();
  const parent = env.DSH_PARENT_SESSION?.trim();
  const lineage = lineageMeta({ env, parentDepth: await parentDepthOf(persistence, parent) });
  if (lineage.parentSession) {
    onNotice?.(`dispatched by ${lineage.parentSession}: recording this session as its child at depth ${lineage.delegationDepth}`);
  }
  const { agent } = await agents.create({ sessionId: fresh, meta: { cwd, ...lineage }, agentOptions, setup });
  return { agent, resumed: false, sessionId: fresh };
}

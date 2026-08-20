/**
 * dsh-headless-resume — a resumable replacement for the one-shot headless runner.
 *
 * The upstream runner mints `session-${randomUUID()}` on every invocation, so a
 * headless process starts from a blank session each time. That single line is
 * what makes durable state unreachable from headless: `dsh-goal` is
 * event-sourced but same-session, so a second process reads `{"goal": null}`,
 * and a plugin like AgentTeams that binds a team to a captain session answers
 * "you do not lead or belong to any active team yet".
 *
 * Nothing deeper is missing. `ctx.agents.resume({ resumeSessionId, ... })` is
 * already part of the Agent registry and `'resume'` is already a valid
 * `SessionStartSource`; the interactive surfaces use that path. This plugin
 * takes the same path from a one-shot process: it remembers which session a
 * named thread last used and resumes it, so goal phase and revisions re-fold
 * from the durable log without a resident daemon.
 *
 * @module dsh-headless-resume
 */
import { randomUUID } from 'node:crypto';
import z from '@deepseek-ai/schemastery';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { defaultIndexPath, defaultKey, lookup, record } from './sessionIndex.js';
import { acquireAgent, summarize } from './runner.js';

/** Stable Cordis plugin name. */
export const name = 'headless-resume-runner';

/** Core services required before the turn can start. Mirrors the upstream runner. */
export const inject = ['agentDefaultModel', 'agents', 'sessions'];

export const Config = z.object({
  /** The task text. Comes from the same `headlessStartup` provider the upstream runner reads. */
  task: z.string().required(),
  /** Thread identity. Defaults to the working directory, which keeps a thread and its cwd consistent. */
  sessionKey: z.string(),
  /** Where the key -> sessionId map lives. Defaults beside the harness home. */
  indexPath: z.string(),
  /** Set false to always start fresh — useful for one-off runs that must not touch a thread. */
  resume: z.boolean().default(true),
  /** Print which session was used, and why, to stderr. Off by default so stdout stays the answer. */
  announce: z.boolean().default(false),
});

/** The process streams the runner writes to; tests substitute captures. */
export const internals = { stdout: process.stdout, stderr: process.stderr };

function fail(io, error) {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  io.exit(1);
}

async function run(ctx, config, io) {
  await ctx.get('loader')?.await();
  const agents = ctx.get('agents');
  const defaultModel = ctx.get('agentDefaultModel');
  const sessions = ctx.get('sessions');
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return;

  const cwd = process.cwd();
  const key = config.sessionKey || defaultKey(cwd);
  const indexPath = config.indexPath || defaultIndexPath(process.env.DSH_HOME, cwd);
  const selection = defaultModel.currentSelection();

  const { agent, resumed, sessionId } = await acquireAgent({
    agents,
    sessionId: config.resume ? lookup(indexPath, key) : undefined,
    newSessionId: () => SessionId(`session-${randomUUID()}`),
    cwd,
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined });
    },
    onNotice: (message) => io.stderr.write(`dsh-headless-resume: ${message}\n`),
  });

  // Record before driving the turn. A run that crashes mid-task has still produced
  // durable events worth resuming into, and losing the pointer would strand them.
  if (!resumed) record(indexPath, key, sessionId);
  if (config.announce) {
    io.stderr.write(`dsh-headless-resume: ${resumed ? 'resumed' : 'started'} ${sessionId} for ${key}\n`);
  }

  await agent.whenIdle();
  const firstSeq = agent.session.seq;
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: config.task }],
    source: { kind: 'user' },
  }));
  await agent.whenIdle();
  await sessions.flush(agent.session);

  const outcome = summarize(agent.session.events, firstSeq);
  io.stdout.write(`${outcome.text}\n`);
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`);
  }
  io.exit(outcome.reason?.kind === 'completed' ? 0 : 1);
}

/**
 * Mount the resumable one-shot driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated config.
 */
export function apply(ctx, config) {
  const exit = ctx.get('appExit');
  if (exit === undefined) {
    throw new Error('headless-resume-runner: the launcher must provide ctx.appExit before the tree mounts');
  }
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit };
  run(ctx, config, io).catch((error) => fail(io, error));
}

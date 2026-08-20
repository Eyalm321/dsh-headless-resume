# dsh-headless-resume

A resumable one-shot runner for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## The problem

`@deepseek-ai/dsh-headless` mints a new session on every invocation:

```js
const { agent } = await agents.create({
  sessionId: SessionId(`session-${randomUUID()}`),
  ...
```

That single line is why durable state is unreachable from a headless profile:

- **Goals vanish.** `dsh-goal` is event-sourced, and its `goal/change` events really are written
  to the session log — but a goal is *same-session*. A second process reads `{"goal": null}`.
- **Teams disown themselves.** A plugin like `@nanmicoder/dsh-agent-teams` writes its task DAG to
  disk, but binds the team to a captain session, so the next process answers
  `you do not lead or belong to any active team yet`.

Both look like missing durability. Neither is — the state is on disk. What is missing is a
*resume surface*, and only from this one bundle.

## The fix

`ctx.agents.resume({ resumeSessionId, agentOptions, setup })` is already part of the Agent
registry, and `'resume'` is already a valid `SessionStartSource`; the interactive surfaces use
that path. This plugin takes the same path from a one-shot process. It remembers which session a
named thread last used, resumes it, and falls back to creating one when there is nothing to
resume.

The result is durability **without a resident daemon** — the state lives in the session log, not
in a live process.

## Install

```sh
dsh plugin --profile <name> add dsh-headless-resume
```

Then replace the stock runner (this is `cordis.patch.yml`, applied for you when the package's
bundle patch is used, or paste it into your profile patch):

```yaml
- id: headless-runner
  disabled: true

- insert:
    - id: headless-resume-runner
      name: 'dsh-headless-resume'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
        sessionKey: !!js process.env.DSH_SESSION_KEY
        indexPath: !!js dshHomePath('session-index.json')
```

The row keeps `inject: [headlessStartup]` and the same `task` expression, so the task still comes
from the stock command-line provider. Only the session identity changes.

## Config

| field | default | meaning |
|---|---|---|
| `task` | *required* | Task text. Read from the stock `headlessStartup` provider. |
| `sessionKey` | `cwd:<cwd>` | Thread identity. Two runs sharing a key share a conversation. |
| `indexPath` | `$DSH_HOME/session-index.json` | Where the key → sessionId map is stored. |
| `resume` | `true` | Set false to always start fresh. |
| `announce` | `false` | Print the session used, and whether it resumed, to stderr. |

## Choosing a session key

**Key by working directory, or include it.** Resuming restores the persisted session's *own*
`cwd` — `meta.cwd` applies to creation only. A thread shared across directories would silently
keep working in the first one. The default key is the cwd for exactly this reason; a named key
(`project:canora`) is safe as long as that name is always used from the same directory.

## Behaviour worth knowing

- **Resuming is best-effort.** A recorded session can be deleted, pruned, or written by an
  incompatible build. None of those fail the run: the plugin reports the reason on stderr and
  starts a fresh session. The thread is a convenience; the task is the job.
- **The pointer is recorded before the turn runs,** so a run that crashes mid-task still leaves a
  resumable thread rather than stranding the events it produced.
- **Old answers are never reprinted.** `summarize()` is bounded at the sequence number the turn
  started from, so a resumed session — which arrives carrying every earlier turn — still prints
  only this turn's reply.
- **Goal activation stays disarmed after a resume.** That is `dsh-goal`'s documented contract:
  activation is never persisted, and every `agent/session-start` edge disarms it. Objective,
  phase, and revision all survive; permission to *continue* must be re-armed deliberately.
- **A resumed session grows.** Compose a compaction plugin for long-lived threads.

## Verified

Against the two failures above, on a real profile:

```
$ DSH_SESSION_KEY=probe dsh --profile p "create_goal 'probe'; get_goal"
started session-6b21ec8a… for probe
{"goal":{"id":"goal-08bf22fd…","revision":1,"phase":"active"},"activation":"armed"}

$ DSH_SESSION_KEY=probe dsh --profile p "get_goal"          # separate process
resumed session-6b21ec8a… for probe
{"goal":{"id":"goal-08bf22fd…","revision":1,"phase":"active"},"activation":"disarmed"}

$ DSH_SESSION_KEY=other dsh --profile p "get_goal"          # unrelated thread
{"goal":null}
```

AgentTeams re-attaches the same way, task DAG and dependency edges intact.

## Tests

```sh
npm test
```

18 tests, no harness required: the resume/create decision and the `summarize` boundary are both
harness-free modules, and one test imports the plugin entrypoint so a syntax or bad-import error
cannot ship green.

## License

MIT

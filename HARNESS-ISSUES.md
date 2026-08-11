# Harness hardening — issue register

Findings from running Prime Agent 0.7.1 on a real 10-item code-triage task
(2026-08-11, session Z17031). Each entry says whether it was **MEASURED** here or
is **UNVERIFIED** — a fix built for a failure we never reproduced is a guess, and
mixing the two is how a register stops being trustworthy.

Upstream is `PrimeIntellect-ai/prime-agent`. Anything here that is a genuine
upstream defect should go back as an issue/PR; anything that is a local policy
difference stays in the fork and is labelled as such.

---

## P0-1 — A blocked child process wedges the agent permanently, silently, unrecoverably

**MEASURED.** Killed a live trial 4 findings in.

The agent ran a shell command through the IPython kernel that blocked on stdin.
Observed state:

```
PID 72624  bash  ppid=76225 (the ipykernel)  etime 9:36  0.0% CPU  STAT S
lsof: fd 0 = PIPE (empty), no children, no other open files
```

The kernel waits on the child, the agent waits on the kernel, and the run stops
dead. Session JSONL last write `08:08:49`, then nothing for 25 minutes.

Three separate deficiencies compound:

1. **No timeout.** Nothing bounds how long a kernel execute may block.
2. **Nothing surfaces.** No error, no warning, no state change, no log line. The
   only evidence the run was alive at all was the session JSONL mtime.
3. **It does not recover.** `kill 72624` cleared the blocked child and the agent
   still did not resume — the pending execute request stays stuck forever. So
   this is not "slow", it is a terminal state reached silently.

**Impact.** Disqualifying for unattended/background work, which is the headline
use case. On a 350-item batch this hangs on item ~12 and reports nothing.

**Direction.** A per-execute wall-clock timeout that (a) kills the child process
group, (b) returns a timeout *as a tool result* so the model can react and try
another approach, and (c) emits a visible event. Sub-points (b) and (c) matter
more than (a): a timeout that merely aborts the run trades a silent hang for a
silent death.

---

## P0-2 — `list` reports "No active agents" while agents are running

**MEASURED.** `prime-agent list` printed `No active agents.` while five
prime-agent processes and an ipykernel were demonstrably running.

Root cause — `packages/coding-agent/src/modes/daemon/daemon-supervisor.ts:1585`:

```typescript
private isVisibleWorker(worker: ResidentWorker): boolean {
    return worker.descriptor.ownerClientId === undefined;
}
```

A worker is visible **only if it has no owning client**. A run started from the
CLI has an `ownerClientId`, so it is filtered out of `list`
(`daemon-supervisor.ts:1416` `case "list"` →
`packages/coding-agent/src/cli/daemon-command.ts:745` `runList` →
`daemon-command.ts:761` prints the message).

**Impact.** The operator-facing answer to "what is running?" is wrong, and wrong
in the dangerous direction: it under-reports. Combined with P0-1 you get a hung
agent that the tooling swears does not exist. It also undermines the documented
cleanup discipline — you cannot stop what you cannot see.

**Direction.** ⛔ Do NOT widen `isVisibleWorker` itself: the same predicate gates
attach/first-worker selection at `daemon-supervisor.ts:1584`, `:1598` and
`:1614`, and loosening it there would change attach semantics. Fix on the **list
path only** — include owned workers with an explicit `owner`/`attached` column so
they are distinguishable, and never print "No active agents" while any worker
exists.

---

## P1-1 — No visible retry/backoff for 5xx (including 529) on the streaming path

**UNVERIFIED — and I want to be precise about why it is in this register.**

We did **not** reproduce a 529 in this run. I initially reported one and was
wrong: the "529" was a substring inside a base64 `thinkingSignature`, not an HTTP
status. AOAR was healthy throughout (200 in 1.8s). That correction matters —
building a retry for a failure we never saw, on the belief it caused the hang,
would have left the real hang (P0-1) unfixed.

It stays P1 on *environment* grounds, not on evidence from this run: our traffic
goes through the AOAR pool, which does genuinely saturate and return 529
("529 Overloaded" is our pool, not an Anthropic outage; the upstream fix,
CuraIQ-dev PR #1870, is unmerged). So we will hit this.

What the code shows (`packages/ai/src/providers/anthropic.ts:527-528`):

```typescript
...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
```

Both are forwarded **only when explicitly set**, otherwise the Anthropic SDK
defaults apply. Open questions to answer *before* writing code:

- Does the SDK's retry cover the **streaming** call (`client.messages.stream`),
  or only unary requests? A mid-stream 529 is the case that matters.
- Is `maxRetries` ever populated in practice, or always `undefined`?
- Does a 529 surface to the user at all, or is it swallowed like P0-1?

**Direction.** Reproduce first — point a test at a stub returning 529, confirm
current behaviour, *then* fix. Retry needs jittered backoff, a cap, and a visible
"retrying, attempt N" event; a silent retry loop is the same observability
failure as P0-1 wearing a different hat.

---

## P1-2 — `-p` buffers all output, so a long run is indistinguishable from a hang

**MEASURED.** `run.log` stayed at **0 bytes for 25 minutes** while the agent did
real work. There is no progress signal in print mode. The only live channel is
the session JSONL under `~/.prime/agent/sessions/`, found by inspection.

**Impact.** This is what turned P0-1 from a 30-second diagnosis into a 25-minute
one, and it is why a watchdog cannot be written against the CLI's own output.

**Direction.** Emit progress to stderr in print mode (tool-call boundaries at
minimum), leaving stdout clean for the final result so piping still works.

---

## P2-1 — Provider base URL is not configurable without writing an extension

**MEASURED.** `ANTHROPIC_BASE_URL` is not honoured — the only occurrences in the
tree are unrelated Cloudflare AI Gateway constants
(`packages/ai/src/providers/cloudflare.ts:16`). Routing Claude traffic through a
corporate proxy therefore requires a TypeScript extension.

Worked around locally with a ~15-line extension calling
`pi.registerProvider("anthropic", { baseUrl, headers })`, which preserves the
built-in models and streaming and swaps only the endpoint. That is a reasonable
extension point and the workaround is small, so this is P2 — but honouring the
conventional env var is a one-line default that every other Anthropic-compatible
tool already supports.

---

## Not a defect — recorded so nobody "fixes" it

- **Detached daemons with `ppid=1` after every run.** This is the documented
  design (closing the terminal must not kill the agent). It bit us only because
  P0-2 hides them and a stale daemon wedges the *next* run. Fixing P0-2 makes
  this manageable; do not change the lifecycle.
- **Every model served as `claude-opus-5` regardless of request.** That is our
  AOAR router, not Prime Agent — the body `model` field is precedence rank 3
  behind a roster pin. Tracked separately as
  `INFRA-AOAR-BODY-MODEL-FIELD-IS-RANK-3-...-001`. Note the consequence for this
  repo: Prime Agent's `/usage` cost figures are wrong in our deployment, because
  it prices the model it asked for, not the one it got.

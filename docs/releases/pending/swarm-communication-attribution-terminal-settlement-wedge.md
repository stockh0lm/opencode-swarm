# Swarm Communication Attribution: Terminal-Settlement Stage A Wedge + Background Phase Participation

## What

Closes the swarm-internal communication failure patterns documented in a
consumer project's `.swarm/swarm_communication_debug.md` (2026-11-23/24,
Wirtschaftssimulation): a green `pre_check_batch` that could not be attributed
after a terminal coder settlement, `phase_complete` reporting
`REQUIRED_AGENTS_MISSING` with `agentsDispatched: []` although every Stage B
role had demonstrably run, the architect being unable to write the plugin's
own loop state file, docs participation receipts being invalidated by the
delivery commits of their own closing window, the architect being unable to
author the keep-the-why personal memory store, plan-critic verdicts going
unrecorded because the dispatch lacked the explicit gate marker, a legit
35-minute coder leg being timeout-aborted at the 30-minute default with its
real committed delivery orphaned, and a leaked in-process dispatch
registration blocking `/swarm recover` until a manual `--force`.

### 1. Terminal-settlement Stage A wedge (route `terminal_settlement_wedge`)

The durable Stage A attribution fallback
(`resolveDurableGateTaskId`) only recognized COMMITTED **accepted** settlements
whose task still sat at `coder_delegated`. A task whose settlement settled
terminal — the no-mutation shape (`dispatch_no_mutation`, e.g. a read-only
delivery) or the accepted-drift shape (#2828) — with its workflow at
`idle`/`blocked` was invisible: a green `pre_check_batch` on exactly the task's
declared files routed as `no_task_correlation`, whose advisory ends with "if
this was an ad-hoc gate run, no action is needed" — actively misleading while
the task wedged and the architect had to rediscover `recover_stage_a_task` by
hand.

- The fallback now recognizes this candidate class (authoritative
  idle/blocked + COMMITTED settlement, accepted or not) and reports it as
  `{ awaitingStageA }` — never as a mechanical write target (the
  `stage_a_passed` reducer is deliberately fail-closed from those states; the
  audited, architect-only `recover_stage_a_task` stays the sanctioned writer).
- Guardrails `toolBefore` and the tool-side self-report (the Code-Mode-nested
  path that produces receipts on OpenCode 2.3.1/2.3.2 hosts) emit a precise
  `STAGE A WEDGE (TERMINAL SETTLEMENT)` advisory naming the task, the
  no-mutation qualifier when applicable, and the `recover_stage_a_task`
  remediation, and record the new bounded `terminal_settlement_wedge` route
  event with the task id — the pattern becomes recognizable in
  `.swarm/events.jsonl` instead of indistinguishable from an ad-hoc run.
- `check_gate_status` surfaces the same wedge diagnosis read-only (idle/blocked
  behind a COMMITTED settlement with Stage A unrecorded), so the wedge is
  visible before the next gate run, not only after it.
- Ambiguity semantics are unchanged and widened conservatively: a wedge
  candidate plus any other durable candidate (eligible or in-flight at
  `coder_delegated`) still forces `attribution_ambiguous`; a file-scope
  mismatch or a truncated settlement scan never yields a wedge resolution.

### 2. Background dispatches now count toward phase required-agents

With `hooks.background_subagents: true`, every Task dispatch (coder, reviewer,
test_engineer, critic, docs) runs through the background delegation pipeline,
which never populated the in-memory phase-aggregation surface
(`phaseAgentsDispatched`/`delegationChains` — those are fed by the
`chat.message` delegation tracker that background children never trigger).
`phase_complete` therefore reported `REQUIRED_AGENTS_MISSING` with
`agentsDispatched: []` for roles whose gate receipts had demonstrably landed.

- The background completion observer's verified-success closeout now records
  the completed role (normalized from the swarm-prefixed agent name) on the
  dispatching parent session via `recordPhaseAgentDispatch` — the same surface
  foreground dispatches write. Idempotent on replay; a no-op when the parent
  session is not live in memory (post-restart shape).
- The `required_agents` gate's task-gate inference was all-or-nothing: because
  `docs` (not task-gate inferable) was also missing, the inference never fired
  for `coder`/`reviewer`/`test_engineer` even though every phase task carried
  full durable gate evidence — producing the confusing "all four missing"
  block. The inference is now per-role: task-gate-inferable roles are cleared
  independently, and a non-inferable missing role stays reported on its own
  (`docs` keeps its durable participation-store check). The inference
  disclosure warning now also surfaces on the blocked arm so the architect
  sees exactly which roles the durable evidence stood in for.

### 3. `.swarm/` runtime state is its own zone (architect loop-state writes)

The zone classifier sent every `.json` path to the `config` zone, and the
architect's default `blockedZones: ['generated', 'config']` (the #894
lint-bypass protection) therefore denied the write the plugin's own loop
skill instructs the architect to make after every gate transition
(`.swarm/loop/<run>/state.json`) — with no escape, because zone blocks cannot
be overridden by allow rules (`AUTHORITY_POLICY_DENY: path is in config
zone`).

- `.swarm/` runtime state (evidence, ledgers, loop state, lane results —
  everything except `.swarm/checkpoints/`, which stays `generated`) now
  classifies as a new `state` zone with a skip-QA policy: it is machine-written
  by the swarm itself, not project source.
- The architect can write it again; the pre-existing protections are
  unchanged and re-pinned by tests: `.swarm/plan.md`/`.swarm/plan.json` stay
  blocked via their exact-path rules, the coder's `.swarm/` prefix block
  holds, and real config files stay denied. Consumers can still lock runtime
  state down explicitly with `blockedZones: ["state"]` (schema enum extended).

### 4. Docs receipts survive the delivery commits of their own closing window

The docs participation freshness check pinned the exact `gitHead` recorded at
dispatch time. The delivery commits of the receipt's own closing window — the
docs agent's committed deliverable, or a sibling task's landing between the
docs dispatch and `phase_complete` — advance HEAD monotonically and staled the
receipt, so `phase_complete` lost the docs proof it had legitimately earned
(the exact Phase-1 docs wedge in the debug log: receipt at `6d37701`, HEAD
moved by the 2.21 and 2.19 delivery commits).

- Freshness is now ancestry-aware: a receipt stays fresh while its recorded
  head is an ANCESTOR of the current head (the workspace only moved forward).
  A divergent or rewound history (another branch checked out, an orphan head)
  is not an ancestor and stays stale, and any Git failure fails closed
  exactly like the strict check.
- Implemented through one bounded `git merge-base --is-ancestor` per drifted
  candidate (`isAncestorCommitAsync` in workspace-snapshot, reusing the
  six-property safe spawn apparatus); equal-head receipts never pay for a
  subprocess call, and the gate read short-circuits on the first fresh
  receipt.

### 5. The keep-the-why personal memory store is a sanctioned write surface

The containment layer rejects every write outside the working directory, and
the host's `permission.external_directory` setting deliberately does not bind
it. The keep-the-why skill (AGENTS.md-mandated in consumer projects)
instructs the architect to author `~/.keep-the-why/<personal>.md` and
`~/.keep-the-why/projects.json` — those writes were denied with
`AUTHORITY_ROOT_ESCAPE` and the only workaround was pasting file contents to
the user (the 2026-11-23 wedge).

- `~/.keep-the-why/**` is now the one sanctioned external write surface: the
  containment deny is skipped for exactly the keep-the-why directory under
  the real home — never arbitrary `$HOME` paths. Planted-symlink hardening
  mirrors the containment walk (no component below the base may be a link;
  ENOENT is allowed for first-time setup, anything unverifiable fails
  closed). Containment is the ONLY layer skipped: universal denies,
  protected paths, zones, prefixes and globs still govern the write.
- `.keep-the-why/` paths (personal or project-local) classify as the `state`
  zone, so `projects.json` no longer reaches the config zone through the
  exemption. Consumers can still lock the store down explicitly
  (`blockedZones: ["state"]` or a `.keep-the-why/` prefix block).

### 6. Plan-critic dispatch-time marker advisory

The auto-approve predicate is deliberately narrow (audit P2-1: a false
positive releases the coder gate on an unverified review): only a critic
dispatch carrying the explicit `critic-gate` marker creates the durable
plan-critic dispatch binding whose existence is the precondition for ANY
automatic approval recording. An architect plan review dispatched without
the marker therefore yields an APPROVED verdict that is never recorded
mechanically, and the next coder dispatch hits `PLAN_CRITIC_GATE_VIOLATION`
(three occurrences for one plan in the debug log, also under the fixed
runtime).

- The fix is advisory at dispatch time, never a widened auto-record: a critic
  dispatch that reads like a plan review but lacks the marker gets a
  non-blocking advisory BEFORE the child starts, naming both sanctioned
  exits — re-dispatch with the `MODE: CRITIC-GATE` marker so the
  pre-execution baseline binds, or record the landed verdict via
  `approve_plan_critic` (the audited escape hatch).

### 7. `background_pending_timeout_minutes` default raised 30 → 60

A legitimately long coder leg (23 identities plus 11 task-mandated serial
verification runs, ~35 minutes) was timeout-aborted at the 30-minute default;
the "ownership transferred to durable background completion" path then went
stale and the real, committed delivery was orphaned behind a wedged workflow
(the 2026-11-24 task-2.20 wedge).

- The schema default and every runtime fallback that reads the knob without
  a parsed config now share one exported constant
  (`DEFAULT_BACKGROUND_PENDING_TIMEOUT_MINUTES = 60`). The generated config
  schema artifact and the recovery guide follow. Consumers with
  short-lived delegations can lower it as before.

### 8. Leaked in-process dispatch registrations expire for recovery

`/swarm recover` refused a non-terminal settlement WAL while the in-process
`liveDispatches` registry held its key — with no expiry. When the
registration's drain path (settle, abort, or the pending-timeout transfer)
never ran, after a session close or a host restart, the leak blocked
recovery indefinitely and demanded the human-only `--force` (the
2026-11-24 restart-aftermath wedge: a registration from a closed parallel
architect session kept report `owned_in_process` although no coder was
running).

- A non-terminal WAL whose dispatch timestamp (`recordedAt`, preserved
  through every WAL rewrite) is older than the configured
  `background_pending_timeout_minutes` plus a 10-minute grace is past every
  path that could still legitimately settle it: recovery now auto-releases
  the registration and proceeds without `--force`, recording
  `releaseReason: "ownership-expired"` on the outcome and the audit event,
  and the report line says so.
- Fail closed everywhere else: a missing or unparsable `recordedAt` never
  expires, and the foreign-live-pid contract is unchanged — another
  process's dispatch is never auto-released from this process.

## Testing

- New: `tests/unit/hooks/guardrails-stage-a-terminal-settlement-wedge.test.ts`
  (wedge routing, no mechanical write, advisory contract, ambiguity widening,
  file-scope mismatch, WAL-less idle, eligible-flow regression pin),
  `tests/unit/tools/phase-complete-required-agents-inference.test.ts`
  (per-role inference, docs-only block, durable docs receipt completion,
  fail-closed incomplete evidence),
  `tests/unit/background/completion-observer-phase-agent-recording.test.ts`
  (verified-success recording, cancelled non-recording, no-parent no-op),
  `tests/unit/hooks/guardrails-swarm-state-zone-authority.test.ts`
  (architect loop-state write allowed; plan projections, coder prefix block,
  config and generated zones, and the explicit `blockedZones:["state"]`
  override),
  `tests/unit/evidence/phase-participation-workspace-ancestry.test.ts`
  (closing-window forward commits stay fresh, equal-head strict path, orphan
  divergence stales, repository-removal fails closed, trusted background
  completion under the allowance),
  `tests/unit/workflow/coder-settlement-ownership-expiry.test.ts`
  (expiry bound: stale/fresh/boundary, PREPARED, terminal and fail-closed
  arms; auto-release without `--force`, registration drained, conservative
  window, unparsable timestamp, foreign live pid never auto-released, the
  schema-default anchor, `--force` release reason),
  `tests/unit/hooks/delegation-gate-plan-critic-marker-advisory.test.ts`
  (unmarked plan review gets the advisory and is not blocked; explicit
  marker and ordinary code review stay silent).
- Extended: `stage-a-self-report.test.ts` (uncorrelated wedge pass),
  `guardrails-stage-a-route-events.test.ts` (closed vocabulary),
  `zone-classifier.test.ts` (state-zone rules, checkpoints rule order,
  skip-QA policy, keep-the-why memory zone, non-dotted negative),
  `phase-participation-storage.adversarial.test.ts`
  (divergence stays rejected; forward movement documented as fresh),
  `guardrails-swarm-state-zone-authority.test.ts` (keep-the-why containment
  exemption: personal file, first-time `projects.json`, planted-symlink
  denial, arbitrary home paths still denied, workspace-local memory,
  explicit consumer lockdown),
  `coder-settlement-recovery-helpers.test.ts` (force release reason),
  `docs/configuration.md` route table (parity test),
  `docs/troubleshooting/recovery-guide.md` default mention,
  `opencode-swarm.schema.json` (regenerated: default 60).

## Invariant audit

- 1 (plugin init): not touched — no init-path changes.
- 2 (runtime portability): touched via rebuild — `bun run build` +
  `tests/unit/build/` (incl. bundle-portability + plugin-shape);
  `dist/index.js` remains a self-contained Node-ESM bundle with no `bun:`
  runtime resolution; the Node smoke check runs in CI (`smoke` job) — no local
  Node binary on this host.
- 3 (subprocesses): touched — `isAncestorCommitAsync` reuses the existing
  `runGitAsync` apparatus (array-form `git -C`, `stdin: 'ignore'`, timeout,
  bounded output, kill in `finally`; revision tokens validated by
  `isSafeGitRevisionToken`); no new spawn call was written directly. The
  ownership expiry adds NO subprocess — it reads the WAL's `recordedAt`.
- 4 (.swarm containment): touched — the keep-the-why exemption is a
  deliberate, bounded narrowing of the containment layer for exactly
  `~/.keep-the-why/**` (planted-symlink-hardened, policy checks still apply,
  consumer lockdown still possible); all other reads/writes stay on existing
  `.swarm/` surfaces. The exemption resolves `~` through an `_internals`
  homedir seam, never a `process.cwd()` caller.
- 5 (plan durability): not touched.
- 6 (test_runner safety): not used; validation via explicit-file `bun test`.
- 7 (test writing): touched — seven new bun:test files (115–356 lines, under
  the FR-006 cap), no `mock.module`, temp dirs via the canonical helpers,
  real-git fixtures following the established spawnSync pattern; symlink
  cases driven through the `#3606`-style `_internals` lstat seam
  (host-independent, no real symlink creation).
- 8 (session state): touched — the recording uses the existing bounded
  `phaseAgentsDispatched` set (no new maps); the pending-route carry keeps its
  existing session/call caps with an extended value shape; the ownership
  expiry adds no new session state (the leaked registration is deleted, not
  moved).
- 9 (guardrails/retry): not touched.
- 10 (chat/system msg): not touched — the new plan-critic advisory rides the
  existing bounded `pushAdvisory` queue (dedupe + length cap).
- 11 (tool registration): not touched — no tool, agent-map, command-shape or
  help changes.
- 12 (release/cache): touched — deployed into the host's active
  `~/.cache/opencode/npm/opencode-swarm@latest/<ts>/` install layout with a
  full pre-change `dist` backup retained for rollback; the local lineage now
  genuinely carries version 7.205.7 (upstream release merged), matching the
  registry latest, so no version stamping is involved.

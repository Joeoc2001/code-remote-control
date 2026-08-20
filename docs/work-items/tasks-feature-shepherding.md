# Work item: Tasks — automatic feature shepherding

## Summary

Add a **Tasks** segment to the UI. A Task takes one issue/work item and drives it all the way to a
merged PR/MR without a human in the loop, by repeatedly evaluating the forge state of the task's
PR/MR and spawning exactly the agent the current state calls for — reusing the five actions we
already have (implement, review, address comments, rebase, fix CI) plus two agent-free actions
(fast-forward rebase, merge).

Today all five actions exist only as *one-shot, human-triggered* prompt templates in
`NewContainerModal.tsx`. The user picks a mode, we snapshot the repo's PR/MR list, and spawn one
container per selected item. Nothing chains them; nothing watches what happens next. This work item
turns that snapshot-and-fire model into a persistent, server-driven control loop.

## What already exists

| Capability | Where |
| --- | --- |
| Spawn a container with an initial prompt | `POST /api/containers` → `createContainer(..., { initialPrompt })` (`packages/server/src/docker.ts`), delivered as `CRC_INITIAL_PROMPT` and run as `claude "$CRC_INITIAL_PROMPT"` in `docker/entrypoint.sh` |
| Bulk spawn | `POST /api/containers/many` |
| The five action prompts | `buildIssuePrompt` / `buildReviewRequestPrompt` / `buildReviewCommentsPrompt` / `buildRebasePrompt` / `buildFixCiPrompt` in `packages/client/src/components/NewContainerModal.tsx` |
| Per-repo issue + PR/MR listing | `GET /api/repo-work-items`, `GET /api/repo-review-requests` → `github.ts` / `gitlab.ts`; `RepoReviewRequest` already carries `hasConflicts`, `ciFailing`, `hasUnresolvedComments` |
| "Is the agent done?" | `GET /api/containers/:id/instance-status` → `/run/crc-instance-status.json`, written by `claude/hooks/instance-status.js` on `UserPromptSubmit` / `Stop` / `SessionEnd` |
| "What PR did this container open?" | `GET /api/containers/:id/code-status` → `code-status.reviewRequest` (`gh pr view` / `glab mr view` inside the container) |
| A server-side polling loop to copy | `healthLoop()` in `packages/server/src/index.ts` (1s tick, re-armed `setTimeout`, cancelled on shutdown) |
| Push to the UI | SSE `/api/events` with `container-updated` / `container-removed` (`docker.ts` `broadcastSSE`) |

## Gap analysis — what we do *not* have

These are the real cost of this work item; the state machine itself is small.

1. **No persistence.** The server holds only in-memory caches and reads a read-only config file.
   Tasks must survive a server restart, so we need a state directory (new volume) and an atomic
   JSON store.
2. **Forge state is too coarse.** `RepoReviewRequest.ciFailing` is a boolean — the loop needs to
   distinguish *running* from *failed* from *no CI at all*. We also have **none** of:
   head SHA, "behind base branch" (needs-rebase), and human approval.
3. **No agent-free actions.** No rebase-without-conflicts call, no merge call.
4. **No task↔PR linkage that outlives a container.** The only place a container's PR is known is
   `code-status`, served by the container itself. Once the container is removed, the link is gone,
   so the task must capture and persist it *before* teardown.
5. **Prompt builders live in the client.** The server needs them; they must move to `shared`.
6. **`github.ts` and `gitlab.ts` have no common interface** — each new field/action would otherwise
   be written twice with two call shapes.

## Design

### Data model (`packages/shared/src/types.ts`)

```ts
export type TaskStep =
  | "implement" | "fix_ci" | "rebase" | "review" | "address_comments";

export type TaskPhase =
  | "spawning"            // agent container being created
  | "agent_running"       // an agent owns the task
  | "waiting_ci"          // CI in flight, nothing to do
  | "waiting_approval"    // green, reviewed, comment-free — needs a human
  | "merging"
  | "merged"
  | "failed"
  | "paused";

export interface TaskAttempt {
  step: TaskStep;
  containerId: string | null;
  headShaBefore: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface Task {
  id: string;
  repoFullName: string;
  repoSource: RepoSource;
  workItem: RepoWorkItem;
  configByStep: Record<TaskStep, string>;   // configuration name per step
  phase: TaskPhase;
  reviewRequest: { id: string; url: string; sourceBranch: string } | null;
  lastReviewedSha: string | null;
  activeContainerId: string | null;
  activeStep: TaskStep | null;
  attemptsByStep: Record<TaskStep, number>;
  attempts: TaskAttempt[];                  // full timeline for the detail view
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
```

`SSEEvent` gains `{ type: "task-updated"; data: Task }` and `{ type: "task-removed"; data: { id } }`.

### The evaluation loop

One scheduler tick (suggested 30s, re-armed `setTimeout` like `healthLoop`, with a re-entrancy
guard). Per tick:

1. Group live tasks by `(repoSource, repoFullName)` and fetch **one** review-request snapshot per
   repo, so N tasks on a repo cost one forge round trip, not N.
2. For each task, run the pure decision function below and execute the returned action.

**Step A — is an agent already working?**

```
if task.activeContainerId:
    status = GET /api/containers/:id/instance-status
    if container is gone           -> record attempt error, clear active, fall through to Step B
    if !status.finished            -> return NOOP
    # finished: capture the PR link before we lose the container
    codeStatus = GET /api/containers/:id/code-status
    if codeStatus.reviewRequest    -> persist onto the task
    remove the container, clear active/step, stamp finishedAt
    return NOOP   # settle: let the forge catch up, decide on the next tick
```

The settle-a-tick rule matters: a PR's mergeable/CI state is not accurate the instant a push lands,
and deciding immediately would spawn a review agent against stale state.

**Step B — no agent running. Evaluate, in this exact order:**

| # | Condition | Action |
| --- | --- | --- |
| 0 | no `reviewRequest` and no `implement` attempt yet | spawn **implement** agent |
| 1 | no `reviewRequest` and `implement` already ran | **fail** the task (`"agent finished without opening a PR/MR"`) |
| 2 | PR/MR is merged | phase `merged`, done |
| 3 | PR/MR is closed without merge | **fail** |
| 4 | `ci.state ∈ {pending, running}` | NOOP (phase `waiting_ci`) |
| 5 | `ci.state == failed` | spawn **fix_ci** agent |
| 6 | `needsRebase && !hasConflicts` | **agent-free** rebase via forge API |
| 7 | `hasConflicts` | spawn **rebase** agent |
| 8 | `headSha !== lastReviewedSha` | spawn **review** agent, then set `lastReviewedSha = headSha` on completion |
| 9 | `hasUnresolvedComments` | spawn **address_comments** agent |
| 10 | `!approvedByHuman` | NOOP (phase `waiting_approval`) |
| 11 | otherwise | **merge** via forge API → phase `merged` |

This is exactly the order you specified. Two consequences worth calling out because they are
emergent, not obvious:

- The review agent's own comments land as unresolved threads, so rule 8 → rule 9 chains naturally:
  review, then fix comments, then (head SHA moved) review again, until a review leaves nothing.
- Any push — fix-CI, rebase, comment fixes — moves the head SHA, so rule 8 re-triggers review after
  every change. That is the "changed since last reviewed" behaviour you asked for, but it means a
  pure rebase costs a full re-review. See open question O3.

Note the existing `git-hygiene.js` `Stop` hook already blocks an agent from stopping until it has
committed, pushed, and watched CI for up to 20 minutes. So in practice rules 4 and 5 will fire less
often than expected — the agent usually fixes its own CI before the shepherd ever sees a red build.
The shepherd's fix-CI branch is the safety net for the timeout case and for failures that appear
after the agent has stopped.

### Forge work required

`RepoReviewRequest` is extended (we own both ends of the API, so change it in place):

```ts
headSha: string;
ciState: "none" | "pending" | "running" | "success" | "failed";
needsRebase: boolean;      // behind base branch
approvedByHuman: boolean;  // excludes our own bot account
merged: boolean;
closed: boolean;
```

| Need | GitHub | GitLab |
| --- | --- | --- |
| head SHA | `headRefOid` in the existing GraphQL query | `sha` on the MR |
| CI state | existing `statusCheckRollup.state` (`EXPECTED/PENDING` → running, `FAILURE/ERROR` → failed, `SUCCESS` → success, absent → none) | `head_pipeline.status` on the MR detail call we already make |
| needs rebase / conflicts | `mergeStateStatus` (`BEHIND`, `DIRTY`, `CLEAN`, `BLOCKED`) — requires the `application/vnd.github.merge-info-preview+json` Accept header | `diverged_commits_count > 0`, `has_conflicts` (already fetched) |
| human approval | `latestOpinionatedReviews` filtered to `APPROVED`, **excluding `config.git.username`** | `GET /merge_requests/:iid/approvals` → `approved_by[]`, same exclusion |
| rebase without conflicts | `PUT /repos/{o}/{r}/pulls/{n}/update-branch` | `PUT /projects/:id/merge_requests/:iid/rebase` |
| merge | `PUT /repos/{o}/{r}/pulls/{n}/merge` | `PUT /projects/:id/merge_requests/:iid/merge` |

The bot-account exclusion is not optional: containers push and comment as `config.git.username`
(`GIT_USER_NAME` in `docker.ts`), and an agent with `gh` in its hands can approve its own PR. If we
counted that, rule 11 would merge unreviewed code.

Caveat on GitHub rebase: `update-branch` performs a **merge** of base into head, not a rebase,
unless the repository is configured otherwise. Either accept a merge commit on GitHub PRs or drop
rule 6 for GitHub and let rule 7's agent handle all divergence. See open question O2.

### Server architecture

New files under `packages/server/src/`:

- `forge/index.ts` — `getForge(source): Forge` with
  `listReviewRequests`, `listWorkItems`, `rebase`, `merge`. `github.ts` and `gitlab.ts` become its
  two implementations. This is the largest refactor in the work item and pays for itself the moment
  a second field is added.
- `tasks/store.ts` — load/save `${CRC_STATE_DIR:-/data}/tasks.json`, write via tmp + `rename`
  (same pattern as `claude/hooks/instance-status.js`). Fail loudly on a malformed file.
- `tasks/decide.ts` — the pure decision function
  `decide(task, reviewRequest | null): Action`. No I/O, so it is trivially testable.
- `tasks/scheduler.ts` — the tick: snapshot repos, call `decide`, execute actions, persist,
  `broadcastSSE("task-updated")`.
- `shared/src/prompts.ts` — the five prompt builders moved out of `NewContainerModal.tsx`, which
  then imports them from `@crc/shared` (its Spawn Many behaviour is unchanged).

`index.ts` starts `taskLoop()` alongside `healthLoop()` and cancels it in `shutdown()`.

### API surface

```
GET    /api/tasks
POST   /api/tasks           { repoFullName, repoSource, workItemIds[], configByStep }
GET    /api/tasks/:id
PATCH  /api/tasks/:id       { phase: "paused" | "resume" } | { configByStep }
DELETE /api/tasks/:id       (also removes the active container)
```

`POST` accepts an array of work item IDs so the UI can start a batch, mirroring
`POST /api/containers/many`. SSE reuses the existing `/api/events` stream.

### UI

- `Header.tsx` gains a two-way segment nav: **Containers** | **Tasks** (routes `/` and `/tasks`).
- `pages/Tasks.tsx` — grid of `TaskCard`s. Each card: work item reference + title, repo, a phase
  badge (reusing the `InstanceStatusBadge` visual language), PR/MR link with the existing
  `ReviewRequestStatusIcon`, current step, a link through to the active container's terminal, and
  pause / retry / delete. Live via SSE, no polling needed.
- `components/NewTaskModal.tsx` — repo picker → work item multi-select → per-step configuration.
  Default to one configuration for every step with a "customise per step" disclosure that reveals
  five selects; most tasks will use the same config throughout.
- `pages/TaskView.tsx` (`/tasks/:id`) — the `attempts[]` timeline: step, start/finish, outcome,
  link to that container's logs.
- Extract the repo picker out of `NewContainerModal.tsx` into `components/RepoPicker.tsx` so both
  modals share it.

## Safety rails

The repo rule is fail fast and loudly, and an unattended loop that spawns containers needs that
more than most code here.

- **Per-step attempt cap** (suggest 3). Third failed `fix_ci` → task `failed` with the reason on the
  card, not a fourth container.
- **Total spawn cap per task** (suggest 12) as a backstop against a two-step oscillation.
- **No PR after implement** → fail immediately (rule 1). Do not retry the implement step.
- **Settle tick** after every agent completion, as described in Step A.
- **Paused tasks are never evaluated**, so a human can freeze a misbehaving task without deleting it.
- **Containers are removed on step completion** once their PR link has been captured, so a long task
  does not accumulate a dozen idle containers.
- A task whose forge snapshot fetch throws records the error and retries next tick; N consecutive
  failures fails the task.

## Open questions

- **O1 — state volume.** Adding `/data` means a compose change for every existing deployment
  (README update required). Acceptable, or should tasks live in a Docker label / a sidecar?
  Recommendation: a `/data` bind mount; nothing else in this app needs a database.
- **O2 — GitHub rule 6.** Accept `update-branch`'s merge commit, or skip rule 6 on GitHub and route
  all divergence through the rebase agent? Recommendation: skip rule 6 on GitHub — a merge commit on
  a PR that a rebase agent would otherwise clean up is a worse outcome than one more container.
- **O3 — re-review after a mechanical rebase.** Rule 8 fires after a fast-forward rebase that
  changed nothing semantically. Options: always re-review (simple, costs a container), or add a
  `reviewAfterRebase` flag per task. Recommendation: ship "always", add the flag if it grates.
- **O4 — merge method** (merge / squash / rebase) and delete-source-branch: per task, per repo, or a
  global default in `environments.json`? Recommendation: a top-level default in the config file,
  overridable per task later.
- **O5 — approval requirement.** Rule 10 means every task stops for a human. Should there be an
  opt-in "auto-merge without approval" for trusted repos? Recommendation: not in v1.
- **O6 — tests.** The repo has no test runner; `npm run typecheck` is the only gate. `decide.ts` is
  pure and is the one piece where a bug silently burns containers. Worth adding `node --test` for
  it alone?

## Implementation plan

Each phase is independently mergeable and leaves the app working.

1. **Forge unification** — introduce `Forge`, move `github.ts`/`gitlab.ts` behind it, extend
   `RepoReviewRequest` with `headSha`, `ciState`, `needsRebase`, `approvedByHuman`, `merged`,
   `closed`. Existing Spawn Many modes switch to the new fields (`ciFailing` → `ciState === "failed"`).
2. **Forge actions** — `rebase()` and `merge()` on both implementations, unused for now.
3. **Prompt builders → `@crc/shared`**, `NewContainerModal` imports them. Pure refactor.
4. **Task store + types + CRUD API**, no scheduler. Tasks can be created and listed but do nothing.
5. **Scheduler + `decide.ts`** — the loop goes live behind the existing attempt caps.
6. **UI** — nav segment, Tasks page, NewTaskModal, TaskView, SSE wiring, `RepoPicker` extraction.
7. **README** — the `/data` volume, what a Task is, and the safety caps.

Phases 1–3 are refactors with no behaviour change and could land as one PR; 4–6 are the feature.

## Risks

- **Forge API rate limits.** Mitigated by one snapshot per repo per tick; at a 30s tick and a
  handful of repos this is well inside both providers' budgets, but the GraphQL cost of adding
  `mergeStateStatus` + `latestOpinionatedReviews` to the existing query should be checked.
- **`mergeStateStatus` is asynchronous.** GitHub computes mergeability lazily and returns `UNKNOWN`
  on a cold read. Treat `UNKNOWN` as "wait", never as "no conflicts".
- **Runaway container spawning** — the caps above are the only thing between a bad decision function
  and a host full of containers. This is why `decide.ts` is pure and worth testing (O6).
- **A stale `finished` flag.** The known limitation in the README — interrupting a turn with Esc
  fires no hook — leaves `instance-status` reading "Working" forever, which would wedge a task in
  Step A. Consider a per-attempt wall-clock timeout that fails the attempt loudly.

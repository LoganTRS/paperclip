# Issue tracker: Paperclip + GitHub (hybrid)

This repo uses **two trackers with distinct jobs**. The running agent is
already inside a Paperclip task/issue with `PAPERCLIP_API_URL`,
`PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, and `PAPERCLIP_TASK_ID` in its
environment, and (for this repo) a `GITHUB_TOKEN` in its run environment for
`gh` writes.

- **The wayfinding map and its decision tickets live in Paperclip.** You
  (the human) manage the map and answer its questions in Paperclip.
- **The real code tickets — the deliverable the wayfinding produces — are
  GitHub issues labeled `code`.** A GitHub Actions workflow
  (`.github/workflows/paperclip-label-routing.yml` →
  `scripts/paperclip-label-router.mjs`) watches for `code`-labeled issues and
  auto-assigns them to an OpenHands agent in Paperclip, which works the
  ticket, blocks on you via a question card when stuck, and opens a PR you
  review before merge.

Do **not** write `.scratch/` files. Do not mix the two: decision/wayfinding
artifacts go to Paperclip, buildable code tickets go to GitHub.

## Paperclip (map + decision tickets + questions)

### Auth and headers (every call)

```
api="${PAPERCLIP_API_URL%/}"
[ -z "$api" ] && api="http://127.0.0.1:3100/api"
case "$api" in */api) ;; *) api="$api/api" ;; esac

curl -sS "$api/issues/$PAPERCLIP_TASK_ID" \
  -H "Authorization: Bearer $PAPER...KEY" \
  -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"
```

- `GET` calls need only `Authorization`.
- Mutating calls (`POST`/`PATCH`/`DELETE`) also need `X-Paperclip-Run-Id`.
- Company ID comes from `GET /api/agents/me` (or `PAPERCLIP_COMPANY_ID`).
- The `paperclip` skill is loaded for every run; its **Key Endpoints** and
  **references/api-reference.md** are the source of truth for request bodies.
- **Never print the API key or the GitHub token.**

### Create / read / update a Paperclip issue (subtask of the current task)

```
# map: a subtask of the current task (or a top-level issue if there is none)
POST /api/companies/{companyId}/issues
{ "title": "<effort>: wayfinding map", "parentId": "$PAPERCLIP_TASK_ID", "status": "in_progress" }

# decision ticket: a subtask of the map issue, question in the description
POST /api/companies/{companyId}/issues
{ "title": "<ticket name>", "parentId": "<mapIssueId>", "status": "todo",
  "description": "Type: grilling\nStatus: open\n\n## Question\n<the decision>" }

# read an issue (returns blockedBy / blocks with id/identifier/title/status)
GET /api/issues/{issueId}

# list the map's open children
GET /api/companies/{companyId}/issues?status=todo,backlog,in_progress,in_review,blocked

# add a comment
POST /api/issues/{issueId}/comments  { "body": "…" }

# update status
PATCH /api/issues/{issueId}  { "status": "in_review", "comment": "…" }
```

Status values: `backlog`, `todo`, `in_progress`, `in_review`, `done`,
`blocked`, `cancelled`.

### When a skill says "publish to the issue tracker" (wayfinding)

Create a Paperclip issue as above. This is for the map, its decision tickets,
and the spec. It is **not** where the final code tickets go.

### When a skill says "fetch the relevant ticket" (wayfinding)

Read it with `GET /api/issues/{issueId}`. The user normally passes the
identifier or ID; resolve a bare number against the company's issue list if
needed.

### Wayfinding operations (Paperclip map + decision tickets)

Used by `/wayfinder`. The **map** is one Paperclip issue; its **decision
tickets** are child issues. All decisions live in Paperclip so you can manage
them there.

- **Map**: one issue titled `<effort>: wayfinding map`, its body carrying
  `## Destination` / `## Notes` / `## Decisions so far` / `## Not yet
  specified` / `## Out of scope`. Create it as a subtask of the current task
  if the effort started from one, otherwise as a top-level issue.
- **Decision ticket**: a subtask of the map. Put its `## Question` in the
  `description`, with a `Type:` line (`research` / `prototype` / `grilling` /
  `task`) and a `Status:` line (`open` / `claimed` / `resolved`) at the top.
- **Blocking**: `blockedByIssueIds` (Paperclip's native dependency, UI-visible
  and auto-waking). Create tickets first (to get IDs), then wire edges in a
  second pass: `PATCH /api/issues/{childId}` with
  `{ "blockedByIssueIds": ["<blockerId>"], "status": "blocked" }`. A ticket is
  unblocked when every issue in its `blockedBy` is `done`.
- **Frontier**: the map's open children whose `blockedBy` are all `done`, with
  no `Status: claimed` in the description, first in creation order.
- **Claim**: before any work, `PATCH /api/issues/{ticketId}` with
  `{ "assigneeAgentId": "{your-agent-id}", "description": "<add Status: claimed>" }`
  (your ID from `GET /api/agents/me`). An open, unassigned, unclaimed ticket is
  unclaimed.
- **Resolve**: post the answer as a resolution comment, set `Status: resolved`,
  `PATCH` the ticket to `done`, then append a one-line gist + issue identifier
  to the map's `## Decisions so far`.

#### Resolving a HITL decision ticket (non-negotiable)

A **HITL** ticket (`grilling`, `prototype`, and any `task` that needs the
human) resolves only through a live exchange, and **the question must be
delivered as a Paperclip `ask_user_questions` issue-thread interaction, never
as plain markdown prose.** The plain-text `❓ Q1 / ➡️ recommended` format from
the `grilling` skill is forbidden here: it creates no durable waiting path,
renders no card, and violates this company's disposition rule (ask via
`ask_user_questions`, never in comment text) — which triggers a watchdog
recovery and is the "blocks and I can't reply" failure.

For each HITL ticket you claim, post a question card and **wait** for it:

```json
POST /api/issues/{ticketId}/interactions
{
  "kind": "ask_user_questions",
  "idempotencyKey": "questions:{ticketId}:wayfinder:{round}:v1",
  "title": "<ticket name> — <one-line decision>",
  "resolverPolicy": "human_only",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "questionSet": {
      "schema": "paperclip.question_set.v1",
      "questions": [
        { "id": "d1", "prompt": "<the decision, with your recommended answer>",
          "answerMode": "single_select", "required": true,
          "customAnswer": { "enabled": true },
          "options": [
            { "id": "a", "label": "<recommended choice>", "description": "<why>" },
            { "id": "b", "label": "<alternative>" }
          ] },
        { "id": "open", "prompt": "<open-ended follow-up, if any>",
          "answerMode": "text", "required": false }
      ]
    }
  }
}
```

Rules for the card:

- **`continuationPolicy: "wake_assignee"` is required.** It resumes the run
  with the saved answer when you respond. Without it the agent posts the card
  and never resumes — the "blocks for a while and I can't send anything"
  failure.
- **`resolverPolicy: "human_only"`** so only a person answers (the point of a
  HITL ticket). Omit it only if an agent may answer.
- Send **one complete `questionSet`** per round containing every text and
  choice question (grilling's whole frontier, breadth-first). `answerMode` is
  `text` for open answers, `single_select`/`multi_select` for decisions with
  ≥2 meaningful choices (choice questions need ≥2 options).
- **After creating the card**, verify it is saved and `pending`
  (`GET /api/issues/{ticketId}/interactions`), then move the ticket to a
  waiting posture and exit the run:
  `PATCH /api/issues/{ticketId}` `{ "status": "in_review", "comment": "Waiting
  on the question card posted on this ticket; answering it resumes me." }`.
- **On resume** the run wakes with the saved `result`. Read it, record it as
  the resolution comment, close the ticket, and graduate the fog it cleared.
- Never stand in for the human's side of a HITL exchange; never re-ask a
  question the card already answered.

AFK types resolve without a card:
- **Research** (AFK): dispatch a research subagent; record findings in a
  resolution comment and close.
- **Task**: AFK where the agent can drive it alone; otherwise hand the human a
  precise checklist via an `ask_user_questions` card, not prose.

## GitHub (the real code tickets)

Used by `/to-spec` and `/to-tickets` to publish the **buildable work** the
wayfinding produced. These are the issues the OpenHands agents pick up, so
they are GitHub issues with the `code` label.

All operations use the `gh` CLI. It infers the repo from `git remote -v`
(`origin` = `https://github.com/paperclipai/paperclip.git`). Use `GITHUB_TOKEN`
for auth (it is in the run environment). Prefer heredocs for multi-line bodies.

- **Create a code ticket**: `gh issue create --title "…" --body-file … --label code`
  (add `--label ready-for-agent` if that triage label exists in the repo).
- **Read a code ticket**: `gh issue view <number> --json number,title,body,labels,comments`.
- **List open code tickets**: `gh issue list --state open --label code --json number,title,body,labels,comments`.
- **Native blocking**: GitHub issue dependencies where available
  (`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by
  -F issue_id=<blocker-db-id>`); otherwise a `Blocked by: #<n>` line in the
  child body. A ticket is unblocked when every blocker is closed.
- **Close**: `gh issue close <number> --comment "…"`.

### When a skill says "publish to the issue tracker" (code tickets / spec)

- **The spec** (`/to-spec`): publish it as a **GitHub issue** labeled
  `code` (and `wayfinder:spec` if present) so it sits with the work it
  specifies and is discoverable in GitHub.
- **Code tickets** (`/to-tickets`): publish **one GitHub issue per ticket**,
  each labeled `code`, in dependency order (blockers first) so blocking edges
  can reference real `#numbers`. These are the issues the OpenHands agents
  auto-spawn from.

### When a skill says "fetch the relevant ticket" (code tickets)

Read it with `gh issue view <number>`; if a bare number is also a PR, try
`gh pr view <number>` first.

### The handoff boundary (wayfinder → code tickets)

The wayfinder map is **decisions**, not build work. When the map is clear (the
way is visible, no decisions left open), the wayfinding is done. Its output is
handed to `/to-spec` (synthesize the decisions into a spec) and `/to-tickets`
(break the spec into tracer-bullet **GitHub `code` issues**). Do **not** turn
wayfinding decision tickets into code tickets directly, and do not close the
wayfinding map when the code tickets are created — the map records the route
walked; the code tickets are a fresh effort that starts from the spec.

## Idempotency

- Paperclip interactions: use the stable `idempotencyKey` shown above so a
  retried run reuses the pending card instead of stacking duplicates.
- Paperclip issues: guard against double-create by listing the map's children
  before creating a ticket and reusing an existing one with the same title.
- GitHub issues: before creating a code ticket, `gh issue list --label code`
  and check for an existing ticket with the same title; reuse it rather than
  duplicating.

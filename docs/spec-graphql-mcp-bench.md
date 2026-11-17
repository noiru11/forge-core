# Spec — GraphQL checks, MCP checks, Benchmark suite (github-core-clone-01)

Source of truth: `/tmp/makefun/github-core-clone-01-kit/program/env/src/` — `checks-graphql.ts`, `graphql-client.ts`, `checks-mcp.ts`, `mcp-client.ts`, `bench.ts`, `calibration.json`, plus manifest constants quoted in the file headers. This is a specification for building a conforming server; no server code is prescribed here.

---

## 1. GraphQL conformance group (20 checks)

### 1.1 Wire

- Endpoint: `POST <base-url>/api/graphql`.
- Headers: `Accept: application/json`, `Content-Type: application/json`, `User-Agent: makefun-github-core-clone-env/1`, `Authorization: Bearer <trial token>`.
- Body: JSON `{query, variables}`. Single-op responses must be **one JSON object** (an array is a parse error for the client); the envelope is `{data, errors}`.
- Rules:
  - A GraphQL-level failure (unknown field, bad argument) is **HTTP 200 with an `errors` array** — never HTTP 400/500.
  - Every check except `invalid-field` treats any non-empty `errors` array as failure. So all normal operations must return 200 with `data` and no `errors`.
  - Unauthenticated request (no/invalid token) → **HTTP 401**.
  - Unknown repository → HTTP 200, `data.repository` = `null`, **`errors` empty** (nullable repository field).
  - A response body with neither `data` nor `errors` is a parse error for the client.
- **Schema: introspection is sufficient.** The client never sends SDL and never validates against a schema of its own; the checks call the introspection queries below. The server must answer `__type(name: ...)` for the types listed (with `fields(includeDeprecated: Boolean)` and `enumValues(includeDeprecated: Boolean)`), plus `Query.viewer`, `Query.repository`, `Query.node` and the mutations. No SDL upload/endpoint exists in the suite.
- **Batching**: a JSON **array** of `{query, variables[, operationName]}` objects in one HTTP body (two operation documents) must be answered by a JSON **array** of per-operation envelope objects, in the same order.

### 1.2 Schema surface (exact)

Query:
- `viewer { login }` — login is a non-empty string equal to the token owner's login.
- `repository(owner: String!, name: String!) -> Repository` (nullable, see above).

Repository (fields that must exist, verified via `__type(name: "Repository")` too):
`id`, `databaseId`, `name`, `nameWithOwner`, `owner { login }`, `defaultBranchRef { name }`, `viewerPermission`, `hasIssuesEnabled`, `issue(number: Int!)`, `issues(first: Int, states: [IssueState!], orderBy: {field: IssueOrderField!, direction: OrderDirection!}, after: String)`, `pullRequests(first: Int)`, `pullRequest(number: Int!)`.

- `viewerPermission` values accepted: `ADMIN | MAINTAIN | WRITE | TRIAGE | READ`. For the token owner: any of these; `hasIssuesEnabled` must be `true`; `defaultBranchRef.name` must equal the repo's actual default branch (the fixture pushes a first commit to it, then reads it back).
- `id` is a Relay-style global id: **non-empty, opaque, must not equal `String(databaseId)`**, and stable across repeated reads. Same for issue `id` (must not equal the plain number).
- `nameWithOwner` must equal `"<owner>/<name>"`.

Issue: `id`, `number`, `title`, `state`, `body` (all must be listed by `__type(name:"Issue").fields`).

IssueConnection: `nodes`, `pageInfo { hasNextPage, endCursor }`.

PullRequest: `id`, `number`, `state`, `merged`, `headRefName`, `baseRefName`, `mergeable`, `files(first: Int)`.
PullRequestConnection: `nodes`. PullRequestChangedFile: `path`.

`Query.node(id: ID!)` → `Node` with inline fragment `... on Repository { name, nameWithOwner }`; round-trips the repository's global `id`.

Enums (must exist with these values):
- `IssueState`: `OPEN`, `CLOSED`
- `MergeableState`: `MERGEABLE`, `CONFLICTING`, `UNKNOWN`
- `PullRequestState`: `OPEN`, `CLOSED`, `MERGED`
- `PullRequestMergeMethod`: `MERGE`, `SQUASH`, `REBASE` (only `SQUASH` is exercised)
- `RepositoryPermission`: `ADMIN/MAINTAIN/WRITE/TRIAGE/READ`
- `SearchType`: must include `ISSUE` (read via `enumValues`; other members unconstrained)
- `IssueOrderField`: `CREATED_AT`, `UPDATED_AT`, `COMMENTS` (only `CREATED_AT` exercised)
- `OrderDirection`: `ASC`, `DESC` (only `DESC` exercised)

Mutations (payload shapes exact):
- `createIssue(input: CreateIssueInput { repositoryId, title, body })` → `{ createIssue { issue { number, id } } }`. Created issue must be visible on REST `GET /api/v3/repos/{o}/{r}/issues/{number}` (state `open`, same title).
- `closeIssue(input: CloseIssueInput { issueId })` → `{ closeIssue { issue { number, id, state } } }`; `state` must come back `CLOSED`, and REST shows `closed`.
- `createPullRequest(input: CreatePullRequestInput { repositoryId, baseRefName, headRefName, title })` → `{ createPullRequest { pullRequest { number, id, state, headRefName, baseRefName } } }`. Expected back: `state: "OPEN"`, `headRefName`/`baseRefName` echoed exactly as sent, positive `number`, non-empty `id`; REST `GET /api/v3/repos/{o}/{r}/pulls/{number}` reads `head.ref` and `base.ref` to the same branch names.
- `mergePullRequest(input: MergePullRequestInput { pullRequestId, mergeMethod })` → `{ mergePullRequest { pullRequest { number, merged, state } } }`, called with `mergeMethod: "SQUASH"`; expected `merged: true`, REST shows `merged: true`, `state: "closed"`.
- `addComment(input: AddCommentInput { subjectId, body })` → `{ addComment { commentEdge { node { id, body } } } }`; body echoed; REST `GET .../issues/{n}/comments` lists it.

Argument forms the suite actually sends: string/int variables, inline enum lists (`states: [OPEN]`), inline input objects (`orderBy: {field: CREATED_AT, direction: DESC}`), null variables (`after: null`), named operations, and batched array bodies.

### 1.3 The exact documents sent (verbatim documents exist in `checks-graphql.ts` `GRAPHQL_DOCUMENTS`; semantics here)

| Key | Document | Sent as | Assertions |
|---|---|---|---|
| viewerLogin | `query ViewerLogin { viewer { login } }` | no vars | login == token owner |
| repositoryFields | `query RepositoryFields($owner: String!, $name: String!)` — repository fields listed above | owner/name | id, databaseId, name, owner.login, defaultBranchRef.name, viewerPermission enum, hasIssuesEnabled true |
| issueFields | `query Issue_fields { Issue: __type(name: "Issue") { fields(includeDeprecated: true) { name } } }` | — | field names include id, number, title, state, body |
| typeFields | `query PullRequestAndRepositoryFields` — two `__type` aliases (`PullRequest:`, `Repository:`) with fields(includeDeprecated: true) { name } | — | PullRequest lists id/number/headRefName/baseRefName/mergeable/state/merged/files; Repository lists id/databaseId/name/nameWithOwner/owner/defaultBranchRef/viewerPermission/hasIssuesEnabled/issue/issues/pullRequests/pullRequest |
| searchTypeEnumValues | `query SearchType_enumValues { SearchType: __type(name: "SearchType") { enumValues(includeDeprecated: true) { name } } }` | — | includes `ISSUE` |
| openIssues | `query OpenIssues($owner,$name,$first)` — `issues(first: $first, states: [OPEN], orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number title state id } }` | first: 10 | ≤10 nodes, all state OPEN, strictly non-increasing issue numbers down the list (numbers[i] ≤ numbers[i-1]) — i.e. **DESC = newest first = largest numbers first**, closed issue absent, all open fixtures present |
| issueByNumber | `query IssueByNumber` — `issue(number: $number) { number title state id body }` | — | exact title/body/state/id round-trip |
| createIssue | `mutation IssueCreate($input: CreateIssueInput!)` | input {repositoryId, title, body} | see mutations |
| closeIssue | `mutation IssueClose($input: CloseIssueInput!)` | input {issueId} | state CLOSED + REST parity |
| pullRequests | `query PullRequests` — `pullRequests(first: $first) { nodes { number headRefName baseRefName mergeable state } }` | first: 5 | fixture PR listed, OPEN, head/base echoed, mergeable ∈ enum |
| pullRequestFiles | `query PullRequestFiles` — `pullRequest(number:).files(first: 10) { nodes { path } }` | — | includes the branch's changed path |
| pullRequestId | `query PullRequestId` — `pullRequest(number:) { id number }` | — | used to fetch global id |
| createPullRequest | `mutation PullRequestCreate($input: CreatePullRequestInput!)` | input {repositoryId, baseRefName, headRefName, title} | see mutations |
| mergePullRequest | `mutation MergePullRequest($input: MergePullRequestInput!)` | input {pullRequestId, mergeMethod: "SQUASH"} | merged true + REST parity |
| addComment | `mutation AddComment($input: AddCommentInput!)` | input {subjectId, body} | body echoed + REST parity |
| invalidField | `query ViewerInvalidField { viewer { login noSuchFieldOnViewer } }` | — | **expects** HTTP 200 + errors array whose messages mention `noSuchFieldOnViewer` |
| nodeRepository | `query NodeRepository($id: ID!) { node(id: $id) { id ... on Repository { name nameWithOwner } } }` | repo global id | round-trips |
| issuesPage | `query IssuesPage($owner,$name,$first,$after: String)` — `issues(first: $first, after: $after) { nodes { number } pageInfo { hasNextPage endCursor } }` | first: 5, after: null then cursor | 7-issue repo pages 5 + 2; first page hasNextPage true + non-empty endCursor; second page hasNextPage false; no duplicates; union == fixture |

### 1.4 The 20 checks (slug, timeout)

1. viewer-login (8s) · 2. repository-fields (10s) · 3. introspection-issue (8s) · 4. introspection-types (10s, covers the 3 remaining gh probes) · 5. issues-open-order (12s) · 6. issue-by-number (10s) · 7. create-issue (12s) · 8. close-issue (12s) · 9. pull-requests-list (15s) · 10. pull-request-files (12s) · 11. create-pull-request (15s) · 12. merge-pull-request (15s) · 13. add-comment (12s) · 14. invalid-field (8s) · 15. unauthenticated (8s) · 16. node-repository (10s) · 17. unknown-repository (8s) · 18. batched-operations (10s) · 19. global-id-stability (12s) · 20. issues-pagination (12s).

Fixture notes: the group builds its own fixtures through the entry's own REST (`/api/v3`) + git-push surfaces, into `<repo.name>-graphql` (plus `-pages` and `-missing` suffixed repos); 3 open + 1 closed issues; PRs need branches created via a git adapter; a repo create accepts 201/200/422/409 on POST /user/repos (idempotent re-run). PR creation accepts 201, or 422 followed by listing `GET /pulls?state=all` to find the existing open PR for that head.

### 1.5 Error handling summary (GraphQL)

- HTTP 200 + `errors[]` for validation/unknown-field errors (invalid-field check depends on it; all other checks treat it as failure).
- HTTP 200 + `data: {repository: null}` and no `errors` for an unknown owner/name.
- HTTP 401 for missing/invalid bearer token.
- Batching: array body → array of `{data, errors}` in order, one HTTP 200.
- Introspection queries must work; no schema SDL is required — introspection alone suffices.

---

## 2. MCP conformance group (15 checks)

### 2.1 Transport — JSON-RPC over Streamable HTTP at `<base-url>/mcp`

Client (mcp-client.ts) behavior the server must accommodate:

- Every POST: `Content-Type: application/json`, `Accept: application/json, text/event-stream`, `Mcp-Protocol-Version: <revision>` (header), and mirrored headers `Mcp-Method: <rpc method>` and (for tools/call) `Mcp-Name: <tool name>` (value-encoded: plain ASCII as-is, else `=?base64?<b64-utf8>?=`). `Authorization: Bearer <token>` when a token exists. `Mcp-Session-Id: <session>` on every request once a response has handed one out (the header is **optional** server-side: the client only echoes what it received).
- Every request's params carry `_meta`:
  - `io.modelcontextprotocol/protocolVersion: <negotiated revision>`
  - `io.modelcontextprotocol/clientInfo: {name: "makefun-github-core-clone-env", version: "1.0.0"}`
  - `io.modelcontextprotocol/clientCapabilities: {}`
  - plus a plain `protocolVersion: <revision>` key (older-server spelling).
- Responses may be **either** one JSON body **or** a request-scoped SSE stream (`Content-Type: text/event-stream`) whose final `data:` frame before a blank line is the JSON-RPC response (the client parses SSE frames, skipping notifications/comments, and cancels the stream once it has the matching id). Both are acceptable.
- The client never throws for an HTTP status; it captures status/body/rpc and the checks judge. It throws only for no answer / timeout (default per-request timeout **3000 ms**, capped by the check's budget) / abort.
- Session: `close()` issues a best-effort `DELETE` with the `Mcp-Session-Id` header — servers may ignore it.

### 2.2 Two protocol eras

- **Modern (2026-07-28 and later, preferred):** no handshake. `connect()` first probes `server/discover` (JSON-RPC `method: "server/discover", params: {}`). A successful result must be a `DiscoverResult` carrying (in `_meta['io.modelcontextprotocol/serverInfo']` or a loose `serverInfo`) `name` and `version` (non-empty strings), `capabilities` (with `tools` present), and `supportedVersions: string[]` of `YYYY-MM-DD` revisions (non-empty). The client picks `2026-07-28` if offered, else the first supported entry, and declares it in `_meta` + header thereafter. No session, no GET stream.
- **Legacy (2025-11-25 and earlier):** `initialize` with `params {protocolVersion, capabilities: {}, clientInfo}` offered newest-first over revisions `["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]` (a `2025-06-18` echo is acceptable, must not be failed), then `notifications/initialized`. The negotiated revision is the server's echoed `result.protocolVersion` (validated as a date, else the offered one). `initialize` is sent **without** the `Mcp-Protocol-Version` header. `Mcp-Session-Id` from any response is adopted and echoed thereafter (optional).
- Era detection: a server that answers `server/discover` with JSON-RPC **-32601** (Method not found), HTTP 404, or 405 is pre-discover → legacy handshake. A modern refusal that is not method-not-found (401, 403, 5xx, -32020 HeaderMismatch, -32022 UnsupportedProtocolVersionError, -32600, -32602) is reported as a connection failure — with one exception: `-32022` whose `error.data.supported` names a usable version is retried once with that version. A server speaking neither era fails every check in the group.

### 2.3 Required tools

At least **six** tools; these six must be present by exact name, an alias, or a suffix (server prefixes like `github__create_issue` are allowed — normalized name must end with the normalized canonical/alias, case-insensitive, non-alphanumerics stripped):

| Canonical | Aliases accepted | Semantics |
|---|---|---|
| `create_repo` | create_repository, repo_create, repos_create, repository_create | args `{name, description?, private?}` |
| `get_repo` | get_repository, repo_get, repos_get, repository_get | `{owner, repo}` |
| `create_issue` | issue_create, issues_create | `{owner, repo, title, body?}` |
| `list_issues` | issues_list, issue_list | `{owner, repo, state?}` |
| `create_pull_request` | pull_request_create, pulls_create, create_pr, pr_create | `{owner, repo, title, head, base}` |
| `merge_pull_request` | pull_request_merge, pulls_merge, merge_pr, pr_merge | `{owner, repo, pull_number}` |

Argument mapping: the suite maps its documented argument names onto the tool's own `inputSchema.properties` via normalized-name synonyms (e.g. `owner` may match `owner_login`, `org`, `user_login`, `namespace`…; `repo` may match `repository`, `repo_slug`…; `pull_number` may match `pr_number`, `number`, `issue_number`, `index`; a `full_name`-style property receives `"owner/repo"` when no repo property exists; `head`/`base` match `head_branch`/`base_branch`/`source_branch`/`target_branch`/`branch` etc.). If the inputSchema has a `required` property the suite cannot fill, the check fails naming it — the server should keep required sets within these synonyms. Tool parameters annotated `x-mcp-header` in their inputSchema are mirrored by the client into `Mcp-Param-<header>` request headers.

`tools/list` answers must include a non-empty `description` and an `inputSchema` with `type: "object"` for **every** tool listed. `tools/list` may paginate with `nextCursor` (the client follows up to 10 pages).

### 2.4 The 15 checks

1. **initialize** — serverInfo.name/version non-empty and capabilities.tools present, over whichever era was negotiated.
2. **server-discover** — `server/discover` answers a DiscoverResult with non-empty supportedVersions; a pre-discover server (404 / -32601 / any other refusal, provided initialize then works) passes as "pre-discover revision" and is never failed.
3. **tools-list** — ≥6 tools, all six required ones resolved.
4. **tool-schemas** — every tool: non-empty description + object inputSchema.
5. **create-issue** — tools/call create_issue; REST `GET /api/v3/repos/{o}/{r}/issues` must list an issue with the same title.
6. **list-issues** — tools/call list_issues (state: "open") on a repo where REST created an issue; result text/structuredContent must contain the issue title or its `"number": N`.
7. **create-pull-request** — setup via REST (contents PUT for a base commit, then POST /git/refs to create the head branch, or contents PUT with `branch` as fallback); tools/call create_pull_request; REST reads back the PR with the same head/base refs. Tool result JSON may carry `number`/`pull_number`/`pull_request_number` (otherwise the suite finds the PR by title/head in the list).
8. **merge-pull-request** — PR created via REST setup; tools/call merge_pull_request `{owner, repo, pull_number}`; REST reads `merged: true`.
9. **unknown-tool** — tools/call with name `mcp_no_such_tool_<tag>` must answer a JSON-RPC error **-32602 or -32601**, never HTTP 500, and never a success result.
10. **parse-error** — a non-JSON body (a truncated `tools/list` JSON) must answer **HTTP 400 with JSON-RPC -32700** (HTTP 200 + -32700 also accepted on the pre-2026-07-28 legacy transport).
11. **missing-arguments** — tools/call create_issue with `{}` must answer **JSON-RPC -32602** or a result with `isError: true`.
12. **concurrent-calls** — two tools/call get_repo sent **concurrently** (same client, two in-flight requests) with distinct JSON-RPC string ids (`concurrent-left-<tag>`, `concurrent-right-<tag>`); each answer must carry its own matching `id` and name its own repository. The server must therefore demultiplex responses by id under concurrency.
13. **tools-list-idempotent** — two `tools/list` calls must return **byte-identical** `tools` arrays (`JSON.stringify` equality). Deterministic ordering and stable descriptions are required — no timestamps/randomness in tool listings.
14. **rest-parity** — create_repo then create_issue over MCP; `GET /repos/{owner}/{repo}` and `GET /repos/{o}/{r}/issues/{n}` must return the same objects (repo `id` stable across repeated reads; issue `id` stable; title exact). The tool result's `full_name` may refine the owner/repo.
15. **auth-required** — a tools/call with **no** Authorization header must answer **HTTP 401** (decided before any tool resolution).

Setup REST routes used (all must work as the checks use them): `GET /api/v3/user`, `POST /api/v3/user/repos`, `GET /repos/{o}/{r}`, `PUT /repos/{o}/{r}/contents/{path}` (with and without `branch`), `POST /repos/{o}/{r}/git/refs`, `GET /repos/{o}/{r}/git/refs/heads/{b}` or `/branches/{b}`, `GET/POST /repos/{o}/{r}/issues`, `GET/POST /repos/{o}/{r}/pulls`, `GET /repos/{o}/{r}/pulls/{n}`.

Error codes table: `-32700` parse error (HTTP 400); `-32602` invalid params (missing args; also an acceptable unknown-tool answer); `-32601` method not found (unknown tool or pre-discover discover probe); `-32022` unsupported protocol version (with `data.supported`); `-32020` header mismatch. Never HTTP 500 for a well-formed JSON-RPC request.

---

## 3. Benchmark suite (4 workloads)

### 3.1 Constants

- Workloads: `push`, `clone`, `read`, `write` — run in that order, each with its own budget (manifest budgetMs: **60 s** per workload), capped by the phase budget (**BENCH_PHASE_BUDGET_MS = 240 s** total) and the env's internal deadline.
- **BENCH_ROUNDS = 3** timed rounds per workload; **BENCH_WARMUP_OPS = 5** untimed warm-up operations before the first round of every workload.
- Clock: monotonic `performance.now()`. `ops` per round: push **200**, clone **50**, read **2000**, write **200**.
- Round timing: `startedAt = now()` immediately before the round's operations; `elapsed = roundMs(now() - startedAt)` after the last op. The whole op set for warm-ups + all rounds (push payloads, write titles) is **pre-built before timing starts** — no hashing/deflating is measured. Setup (repo creation — delete-then-create per workload repo `bench-push`/`bench-clone`/`bench-read`/`bench-write`, clone history push, read-issue creation) happens inside the workload budget but **outside every timed round**.
- Failure discipline: every op is checked against the clock before it starts; a deadline timer aborts in-flight requests. A workload that throws, is aborted, or doesn't finish all 3 rounds: completed rounds are still recorded in `rounds`, but `p50_ms`/`p99_ms` = sentinel **1e9** and points = 0. A workload whose T_ref is 0 runs anyway, earns 0 points, and is marked `uncalibrated`.

### 3.2 The workloads

1. **push** — 200 sequential pushes of a 1 KiB change to one repository (`bench-push`, file `bench-data.txt`). Each op = one receive-pack exchange (advertisement + command list + pack) creating one commit on `refs/heads/main`; first push `oldOid = ZERO_OID`, later ones chain parent→newOid. Pack carries exactly the 3 new objects (blob/tree/commit). The push's report-status must show `unpackOk` and the ref update, else the workload fails.
2. **clone** — 50 **concurrent** shallow clones (depth 1, `singleBranch: true`, `parse: false`) of a 200-commit repository (`bench-clone`, file `history.txt`, 512 B per commit blob, one push carrying all 200 commits in setup). A round = `Promise.all` of 50 clones. Verification per clone: pack checksum ok, packBytes > 0, ≥1 ref.
3. **read** — 2,000 **sequential** `GET /api/v3/repos/{owner}/{repo}/issues/{number}` on one warm keep-alive connection (undici pool reuse); setup creates one issue; each read must answer 200 with a JSON object.
4. **write** — 200 **sequential** `POST /api/v3/repos/{owner}/{repo}/issues`; each must answer **201**; titles pre-built (`"<scenario title> [bench N]"`).

### 3.3 Scoring

- Per workload: `p50_ms` = nearest-rank median (rank ⌈0.5·n⌉) of the 3 rounds; `p99_ms` = largest round; points = `round(clamp(25 − 12.5·log2(p50_ms / T_ref_ms), 0, 50))`. T_ref comes from `calibration.json` → `manifest.ts T_REF_MS`.
- Tie-break `perf_p50_us` = `round(1000 · geometric mean of the p50_ms of the workloads that measured)` (sentinel 1e9 when none measured); `points_total` = sum, 0..200. `tiers` = floor(points/12.5).

### 3.4 T_ref values (calibration.json, measured 2026-11-14, median of 3 production-shaped runs)

| Workload | T_ref (p50_ms) | Per-run medians |
|---|---|---|
| push | **1640.82 ms** | 1914.548 / 1640.82 / 1415.785 |
| clone | **266.941 ms** | 266.941 / 313.634 / 259.436 |
| read | **2759.715 ms** | 2874.092 / 2759.715 / 2428.118 |
| write | **348.965 ms** | 448.01 / 348.965 / 289.433 |

Run-to-run tie-break spread 26.36%; geometric mean of medians 805899 µs. At these T_refs the reference forge scores 25 points per workload (100/200). A workload measuring exactly at its T_ref earns 25; twice as slow earns 12.5→13; four times slower earns 0.

### 3.5 perf.json output shape

`{version: 1, calibrated: <all T_ref > 0>, workloads: [{name, rounds: number[], p50_ms, p99_ms, ops, points, error?}], tiers, points, perf_p50_us, points_total, notes[]}` — canonical JSON, points always recomputed from p50_ms + T_ref at assembly time.

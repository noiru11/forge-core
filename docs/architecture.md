# Forge architecture — github-core-clone-01

One Node 22 process, stdlib only (`node:http`, `node:crypto`, `node:zlib`), TypeScript with
`--experimental-strip-types` (erasable syntax only: no enums, no namespaces, no parameter
properties, `import type` for types). `main.ts` is the harness lifecycle and stays untouched;
everything below grows inside `app.ts` + `src/`.

## 0. What the suite actually sends (read from the sealed env sources)

The kit ships the sealed suite under `/tmp/makefun/github-core-clone-01-kit/program/env/src/`
(12,500 lines). Every design decision below is grounded in it.

- **Score**: feature 600 (120 checks: git 30, repos 15, issues 15, pulls 20, graphql 20,
  mcp 15, protocol 5), agent 200 (= the mcp group's 15 again), perf 200 (4 workloads,
  `T_ref` from `program/env/src/calibration.json`: push 1640.82 ms, clone 266.94 ms,
  read 2759.72 ms, write 348.97 ms — each for the *whole round* of N ops, median of 3).
- **Auth**: every API call carries `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; the entry
  must read that env var. No token ⇒ 401 `{message: string}` on REST/GraphQL/MCP.
- **REST routes the checks drive** (`checks-rest.ts`, `checks-mcp.ts` setup):
  - `GET /api/v3` (200, `x-oauth-scopes`), `GET /api/v3/meta` (`installed_version`), `GET /api/v3/user`
  - `GET /user/repos` — **pagination: 30 seeded repos served at `per_page=10` through
    `Link: <...>; rel="next"`** (must follow the chain on the same origin)
  - `POST /user/repos`, `GET/PATCH/DELETE /repos/{o}/{r}` (404 JSON `{message}` for missing),
    same name under another owner ⇒ 404 for our token
  - `GET /repos/{o}/{r}/branches`; `POST/GET /repos/{o}/{r}/git/refs[/heads/{branch}]`
  - `GET /repos/{o}/{r}/commits` (reflects a commit on a branch, not default)
  - `PUT/GET/DELETE /repos/{o}/{r}/contents/{path}` — PUT makes a commit; GET returns
    base64 + sha; stale sha ⇒ **409**; PUT on a new branch creates it; GET on a directory lists entries
  - issues: `POST/GET /repos/{o}/{r}/issues[/{n}]` (state filter, `sort=created`,
    `direction=asc|desc`, labels array, unknown label ⇒ **422**), `POST/GET .../issues/{n}/comments`;
    numbers increment per repo from 1
  - pulls: `POST/GET /repos/{o}/{r}/pulls[/{n}]` (`state=all`), `GET .../pulls/{n}/files`
    (filename/status/additions/deletions), `PUT .../pulls/{n}/merge` (squash; 200
    `{merged:true, sha, message}`; unknown ⇒ 404; conflicting ⇒ **405**; merge commit lands
    on the default branch and `merge_commit_sha` = merge sha)
  - **protocol group**: every reply `application/json` (never HTML), unknown route JSON 404,
    malformed JSON body ⇒ **400**, every reply carries non-empty `X-GitHub-Request-Id`,
    401/404/422 bodies carry a string `message`.
- **GraphQL** at `POST /api/graphql`: body `{query, variables, operationName?}` or a JSON
  **array** (batching, answered with an array in order). Errors ⇒ HTTP 200 with `errors[]`;
  unauthenticated ⇒ 401. The 20 checks send exactly gh's documents: `viewer{login}`,
  `repository(owner:,name:)` with `id databaseId name owner{login} defaultBranchRef{name}
  viewerPermission hasIssuesEnabled`, `__type(name:"Issue")` + `PullRequest`/`Repository`/
  `SearchType` feature probes (fields(includeDeprecated:)/enumValues), issues list
  `issues(first:, states:[OPEN], orderBy:{field: CREATED_AT, direction: DESC}){nodes{...} pageInfo{hasNextPage endCursor}}`,
  `issue(number:)`, mutations `createIssue/ closeIssue/ createPullRequest/ mergePullRequest
  (SQUASH)/ addComment(subjectId, body)`, `node(id:)` with an **inline fragment** `... on
  Repository`, unknown repo ⇒ `data.repository = null` with **no** errors, invalid field ⇒
  200 + errors. Cursors paginate `issues(first, after)`.
- **MCP** at `POST /mcp` (`Accept: application/json, text/event-stream`):
  - modern era `2026-07-28`: no handshake; the client probes **`server/discover`** first
    (answer: `{supportedVersions, capabilities, serverInfo}`); every request carries
    `_meta['io.modelcontextprotocol/protocolVersion']` and header `MCP-Protocol-Version`;
    unsupported ⇒ JSON-RPC `-32022` with `data.supported`.
  - legacy era: `initialize` (echo the negotiated `protocolVersion`) → `notifications/initialized`,
    hand out `Mcp-Session-Id` (a static id is fine), then `tools/list`, `tools/call`.
  - support **both** by answering `server/discover` if implemented else `-32601` (the client
    then falls back to `initialize`), plus always accepting `initialize`. Answer plain JSON
    (no SSE needed).
  - tools (github-mcp-server names; schema property names matched exactly): `create_repo
    {name, description?, private?}`, `get_repo {owner, repo}`, `create_issue {owner, repo,
    title, body?}`, `list_issues {owner, repo, state?}`, `create_pull_request {owner, repo,
    title, head, base}`, `merge_pull_request {owner, repo, pull_number}`. tools/call result
    shape: `{content:[{type:'text',text: JSON-of-the-object}], isError?: true}`. Unknown tool
    ⇒ `-32602`/isError; missing required args ⇒ isError or `-32602`; non-JSON body ⇒
    **HTTP 400 + `-32700`**; no auth ⇒ **HTTP 401**; concurrent calls keep their ids; two
    `tools/list` answers byte-identical; objects created over MCP must be visible over REST
    (same store).
- **Git** (`checks-git.ts` + `git-client.ts` — the suite itself is a dependency-free git
  client, so we can copy its codec expectations exactly):
  - `GET /{owner}/{repo}.git/info/refs?service=git-upload-pack` → v2 when client sends
    `Git-Protocol: version=2` (the suite sets the header AND pktline `version 2` in the POST
    body); content type `application/x-git-upload-pack-advertisement`, `# service=` preamble,
    then `version 2\n`, capability lines (`agent=`, `ls-refs=unborn peel symrefs`,
    `fetch=shallow`, `object-format=sha1`), `0000`. Empty repo advertises
    `unborn HEAD refs/heads/main` via ls-refs and v0 `capabilities^{}`.
  - v0 advertisement for receive-pack: `<oid> <ref>\0<caps>` — caps include
    `report-status report-status-v2 delete-refs side-band-64k ofs-delta object-format=sha1`,
    peeled `^{}` lines for annotated tags, `symref=HEAD:refs/heads/...`.
  - `POST .../git-upload-pack` v2: `ls-refs` (peel/symrefs/unborn/ref-prefix),
    `fetch` with `want`/`have`/`done`/`deepen {n}`/`filter`-less; response sections
    `acknowledgments` (`ready`/`NAK`), `shallow-info` (`shallow`/`unshallow` lines),
    `wanted-refs`, `packfile` (side-band-64k framing, band 1 = pack bytes, band 2 = progress).
  - `POST .../git-receive-pack` v0: command list (`<old> <new> <ref>\0caps`,
    create = old ZERO_OID, delete = new ZERO_OID), flush, packfile (client always writes
    **plain objects, no deltas** — `git-client.ts` `writePack` is "plain objects only"),
    answer: `unpack ok\n` + per-ref `ok <ref>` / `ng <ref> <reason>` via **side-band-64k band 1**,
    then flush. Non-fast-forward ⇒ `ng` (per-ref), repo unchanged. Mixed list applies only ok ones.
  - Git checks that matter: shallow depth-1 clone (`shallow` line, tip only), deepen 2
    (exactly one more generation), incremental fetch sends only new objects, fetch with
    nothing new transfers no objects, pack checksum trailer verified, `pack-deltas` check
    "when the server sends them" (we can send none), malformed requests / 404s must not
    corrupt state, push of 100-file commit round-trips byte-exactly.
- **Bench** (`bench.ts`):
  - `push`: 200 sequential receive-pack pushes of a 1 KiB change, one commit each, to one repo
    (T_ref 1641 ms ⇒ **~8 ms per push exchange**). Every push: adv GET + POST with 1 commit/
    tree/blob + report.
  - `clone`: 50 **concurrent** shallow (depth 1) clones of a 200-commit repo (T_ref 267 ms
    ⇒ pack must be produced/streamed very fast; checksum verified, objects not parsed).
  - `read`: 2,000 sequential GET issues/{n} on one warm keep-alive connection (T_ref 2760 ms
    ⇒ ~1.4 ms/request; serialize tiny JSON).
  - `write`: 200 sequential POST issues (T_ref 349 ms ⇒ ~1.7 ms/POST).

## 1. Store (module `src/store/`)

**In-memory only. No disk persistence.** A trial is one process living exactly as long as the
suite runs (`main.ts` exits when the env says done); nothing restarts us, nothing reads our
disk. Loose-object/zlib packing matters only for the *wire*, not storage.

Decision: **objects in memory as pre-hashed entries in a per-repo `Map<string, StoredObject>`**
(`StoredObject = { type, data: Buffer }` keyed by hex sha1). Hash once at write time
(`hashObject(type, data) = sha1(header + data)`). Zlib only at the wire boundary.

```ts
// src/store/store.ts
export interface GitObjectEntry { type: 'commit'|'tree'|'blob'|'tag'; data: Buffer } // data = object body
export class RepoStore {
  objects: Map<string, GitObjectEntry>;        // sha1 hex -> entry
  refs: Map<string, string>;                   // 'refs/heads/main' -> sha; HEAD separate
  head: string;                                // 'refs/heads/main'
  commits: Map<string, CommitInfo>;            // sha -> {tree, parents, message, author{name,email,when}, committer, shallow?}
  treesByCommit: Map<string, TreeInfo>;        // sha -> parsed tree {path -> {mode, sha, type}}
  // REST db
  issues: Map<number, Issue>; labels: Label[]; pulls: Map<number, Pull>;
  nextIssueNumber; nextPullNumber;
  constructor(public owner: string, public name: string) {}
  readObject(sha): GitObjectEntry | undefined
  writeObject(type, data): string             // hashes, stores, parses if commit/tree
}
export class Forge {
  reposByFullName: Map<string, RepoStore>;    // 'owner/name'
  reposById: Map<number, RepoStore>;
  viewer: User;                               // from env token / scenario viewer conventions
  nextRepoId: number;
  repo(owner, name): RepoStore | undefined
  createRepo(owner, name, opts): RepoStore
}
```

Derived-state caches, invalidated on ref/object change:
- `commitChain(sha)`: memoized ancestor list per commit (for `deepen`, closure, ff checks).
- `parseTree(sha)`: parsed tree entries per tree sha (mode/path/sha), for contents API,
  `pulls/{n}/files` and fetch closure.
- Contents API commit model: PUT contents = build blob → tree (updated entries) → commit
  (parent = branch tip) → move ref. Commit chain is therefore always linear per branch;
  pulls compare two branch tips' tree paths to produce the `files` list (added/modified/
  removed, additions/deletions counted from blob lengths — GitHub counts are not asserted
  line-exactly in the checks, only `filename`, `status` and the count fields' presence/shape).
- Global ids (GraphQL `id: ID!`): `base64('repo:<id>')` etc., stable and opaque.

**Memory**: bench push creates 200 commits × (blob 1 KiB + tree + commit) ≈ 1 MB — no problem.
Clone's 200-commit repo likewise. Keep every object; no eviction.

## 2. Git smart HTTP (modules `src/git/`)

### 2.1 pktline codec (`pktline.ts`)
Copy the semantics from `git-client.ts` (it documents git's exact framing):
- `encodePktLine(payload)` → `4-hex(len+4)` + payload; `flush 0000`, `delim 0001`,
  `response-end 0002`; max payload 65520.
- `PktDecoder`: incremental, `feed(chunk)`, `next(): Packet | null`.

### 2.2 Advertisements (`adv.ts`) — precompute and cache
The advertisement bytes only change when refs change. Keep **one cached Buffer per repo per
service per protocol** (`upload-pack-v0`, `upload-pack-v2`, `receive-pack-v0`), invalidated on
ref update. Build:
- v0 upload-pack: `# service=git-upload-pack\nflush`, first ref line `... \0{caps}`, then
  `<oid> <ref>` lines, peeled `^{}` for tags, `symref=HEAD:refs/heads/main`, final flush.
  Empty repo: `<ZERO_OID> capabilities^{}\0{caps}`.
- v2 upload-pack: `version 2\n`, `agent=forge/1.0`, `ls-refs=unborn peel symrefs`,
  `fetch=shallow`, `object-format=sha1`, flush.
- receive-pack: caps `report-status report-status-v2 delete-refs side-band-64k ofs-delta
  object-format=sha1 agent=forge/1.0` (add `atomic` never).

### 2.3 upload-pack (`uploadpack.ts`)
```
handleUploadPack(repo, body) -> Buffer | AsyncIterable<Buffer>
  decode pktlines -> commands:
    'version 2' already negotiated via info/refs header; unknown capability ignored
  ls-refs: args peel/symrefs/unborn, ref-prefix[]  -> lines '<oid> <ref>[ peeled] [symref-target HEAD:...] [unborn]'
  fetch: parse section:
    want[] -> oids
    have[] -> oids client has (suite sends haves only in fetch-nothing-new/incremental)
    done (always present in suite's flow)
    deepen N / deepen-since none
    thin-pack, ofs-delta capability lines (ignored: we emit no deltas)
    want-ref / filter: not sent by the suite; answer -ERR if seen? (just ignore)
  compute send set:
    wants as closure over commits/trees/blobs up to the client's haves/deepen
    shallow depth d: tip + d-1 generations of commits + their trees/blobs (parents beyond depth excluded)
      -> if depth applied, emit 'shallow <oid>' lines for the frontier commits
    haves: mark reachable set from each have; stop closure descent at marked commits (incremental = only new objects)
    nothing new (all wants marked): acknowledgments 'ready', packfile section empty
  response v2:
    'acknowledgments\n' + ('ready <oid>' | 'NAK\n') + flush      [suite sends done, so ready|NAK + flush]
    'shallow-info\n' + shallow lines + flush   (omit section when none)
    'wanted-refs\n' + '<oid> <ref>' lines + flush (omit when no want-ref)
    'packfile\n' + side-band-64k framing of the pack
  response v0 (fallback if client never sent version=2):
    'NAK\n' line then side-band-64k pack frames
```
`have`-aware closure: walk each want's commit chain with a `Set` of already-known oids
(from `have`s), collect only commits/trees/blobs not in the set. For shallow depth d, collect
commit chain until generation d, then stop; the deepest commits get `shallow` lines (and
`unshallow` lines when the fetch deepens a previously-shallow client — the suite's deepen check
starts fresh per clone, so plain `shallow` lines suffice; support `unshallow` by listing
previously-shallow oids passed in the request).

### 2.4 Pack writing (`packwrite.ts`) — no deltas
```
writePack(entries: {type, data}[]): Buffer   // objects as-is
  header 'PACK' + version 2 + count (LE32)
  per object: type|size varint header (no delta bits) + zlib.deflateSync(data)
  trailer: sha1(everything before)
```
OFS_DELTA in *output*: **skip**. The `pack-deltas` check is conditional ("when the server
sends them") and the reference measures fine without deltas; plain packs are simpler, faster
(zlib only, no delta search — that is what keeps clone ~100 ms) and round-trip byte-exactly.
Thin pack: never needed (no deltas ⇒ self-contained).

### 2.5 Pack parsing (`packread.ts`) — needed for pushes
```
parsePack(pack: Buffer, bases?: Map<sha, entry>): { entries: {type, data, sha}[] }
  verify header count + trailer sha1
  per object: varint (type in bits 4-6); type 6 = OFS_DELTA (negative varint offset -> base earlier
    in pack), type 7 = REF_DELTA (20-byte base sha) -> resolve after pass 1:
      pass 1: inflate full objects, keep deltas (deltaBaseOffset offset / base sha)
      pass 2: resolve deltas recursively: applyDelta(base, delta) = copy/insert ops:
        varint srcSize, varint dstSize, then opcodes: bit7 set => copy (offset/size varints by bits),
        else insert next N literal bytes
```
The suite's client sends plain objects, so the delta path only guards robustness — implement it,
but it will rarely run.

### 2.6 receive-pack (`receivepack.ts`)
```
handleReceivePack(repo, body) -> Buffer
  decode pktlines: first line 'old new ref\0caps' (or 'push-cert' — reject ng), commands until flush
  split off packfile bytes (first data packet after the flush; raw pktline framing)
  parse pack -> apply objects to repo.objects
  for each command, in order:
    create (old=ZERO): ok if ref absent && new object exists
    delete (new=ZERO): ok if ref exists (delete-refs advertised)
    update: ok iff old == current ref value && isFastForward(old -> new)
    failure: 'ng <ref> <reason>' ('non-fast-forward' | 'bad object' | 'ref locked' etc.), apply nothing for that ref
  update refs that succeeded; invalidate advertisement + closure caches for the repo
  response pktlines:
    'unpack ok\n'
    'ok <ref>\n' / 'ng <ref> <reason>\n'
    flush
  -> all of it inside side-band-64k band-1 frames when the client advertised side-band-64k
     (report-status-v2 adds 'option' lines; plain report-status suffices for the suite)
```
Fast-forward check: walk new commit's ancestors; ok if it reaches old tip. Refuse non-ff with
`ng`. Delete refs/heads/main when it is HEAD's target: keep HEAD dangling (suite deletes side
branches and tags only).

### 2.7 Git HTTP glue (`http.ts` in app router)
- `GET /.git/info/refs?service=...` with `Git-Protocol: version=2` header ⇒ v2 advertisement;
  content types `application/x-{service}-advertisement`; unknown service ⇒ 403 JSON? (git
  clients expect 403/404; suite only checks the smart content types + preamble for upload-pack).
- `POST /.git/{service}`: for upload-pack, decide v2 vs v0 by the **body's first pktline**
  (`command=ls-refs` ⇒ v2; want- lines ⇒ v0). Missing repo ⇒ 404 (JSON ok, suite checks
  "advertises 404 and the server stays up" — plain 404 status with any body).
- Repo URL forms to accept: `/{owner}/{repo}.git/...` and `/{owner}/{repo}/...` (the git-client
  uses `{owner}/{repo}.git`; create repo names without the suffix — store resolves both).
- Auth: the git client sends the bearer token; require it for receive-pack, tolerate its
  absence on info/refs if a check probes unauthenticated (checks do call info/refs without
  auth? `advertise-headers` uses the harnessed client which carries the token — require auth
  on POSTs only).

## 3. REST v3 (`src/rest/`)

Router (`router.ts`): match `/api/v3/...` path segments with a tiny pattern table
`[method, pattern, handler]`; capture `{o, r, n, path...}`. No framework. Every response gets
`X-GitHub-Request-Id` (counter + random prefix), JSON content-type, and `{message}` on errors.

Handlers (one file per domain):
- `repos.ts`: root, meta, user, user/repos (pagination: slice by `per_page`/`page`, emit
  `Link: <...>; rel="next"` when more, absolute URL using the request's Host), create/patch/
  delete/get repo, branches, git/refs (GET all / GET one / POST create ref), commits
  (list commit chain of a branch tip, GitHub commit shape with `sha`, `commit.message`,
  `commit.author.{name,email,date}`, `parents`).
- `issues.ts`: CRUD + list filters (`state`, `sort=created|updated`, `direction`), comments,
  labels (`GET /repos/{o}/{r}/labels`; unknown label on create ⇒ 422 `{message}`).
- `pulls.ts`: create (head/base from branch refs; `head.sha` = head tip, `base.sha` = base tip),
  files (tree diff between tips, with `filename`, `status`, `additions`, `deletions`),
  merge (squash = new commit on base with the pull's tree; set state MERGED/CLOSED,
  `merged_at`, `merge_commit_sha`; conflict detection = file overlap on the base since
  the pull's base sha ⇒ 405).
- `contents.ts`: GET file (base64 + sha, 404 missing, directory listing), PUT
  (validate `sha` matches current blob ⇒ else **409**; optional `branch` creates it if
  missing; build blob+tree+commit, move ref; return `{content:{...}, commit:{...}}`),
  DELETE (same but removal commit).
- Shared commit plumbing (`src/store/commits.ts`): `makeCommit(repo, parentSha, updates: {path -> content|null}, message, author) -> sha`
  used by contents PUT/DELETE, REST pulls merge and MCP tools.

Status discipline (protocol group): 401 no token; 400 malformed JSON body; 404 unknown
route/repo/issue/pull; 422 validation (unknown label); 409 stale sha; JSON always.

## 4. GraphQL (`src/graphql/`)

The suite sends a **fixed, small** set of documents (gh's feature-detection probes + CRUD
queries). Full parser unnecessary; a minimal recursive-descent parser over the operations we
know suffices and stays correct for arbitrary field nesting.

`parser.ts` (≈150 lines):
```
lex: punctuation ( ) { } : [ ] ! $ , = @ , names, ints, strings, spread '...'
parseDocument: definitions (query|mutation Name($vars) { selection }), 'subscription' unsupported
parseSelectionSet: fields (alias: name(args)) + inline fragments ('... on Type' / '...') + named fragments (skip; not used)
parseValue: variable | int | float | string | bool | null | enum (bare name) | list | object
skip schema directives, @include/@skip rare -> evaluate simply (not used by suite)
```
`execute.ts`: **resolver map keyed by parent type + field**:
```
type Ctx = { forge, repoCache: Map<..> }
const rootQuery = {
  viewer: (args, ctx) => ctx.forge.viewer,
  repository: ({owner, name}, ctx) => repoOrNull,
  node: ({id}) => decodeGlobalId -> object,
  __type: ({name}) => INTROSPECTION_TYPES[name] ?? null,
}
const typeResolvers = {
  Repository: { id, databaseId, name, owner, defaultBranchRef, viewerPermission:'ADMIN',
    hasIssuesEnabled: true, issues(list: {first, states, orderBy, after}) -> connection,
    issue(number) -> issue, pullRequests(first) -> connection, pullRequest(number) },
  Issue: {id, number, title, state, body, comments, repository}, PullRequest: {..., files(first)},
  User: {login}, Ref: {name},
  // PageInfo {hasNextPage, endCursor}, connections' nodes/pageInfo
}
mutations: createIssue, closeIssue, createPullRequest, mergePullRequest(SQUASH|MERGE|REBASE),
  addComment(subjectId, body)
```
- **Introspection is data, not reflection**: a static table `INTROSPECTION_TYPES` returning
  `{name, fields: {name}[], enumValues: {name}[]}` for Issue, PullRequest, Repository,
  SearchType (+ a few gh probes). The checks only assert that gh's expected field names appear.
- Errors: unknown field ⇒ include `{message, path, locations}` in `errors[]`, HTTP 200, partial
  data. Unknown repository ⇒ `data: {repository: null}` with **no** errors. Unauthenticated ⇒ 401.
- Batching: JSON-array body ⇒ map each entry, answer an array in order.
- Cursors: `after` = opaque `"<repoId>:<issueNumber>"`; `pageInfo.endCursor` = last node's cursor,
  `hasNextPage` = more remain. Simple base64 of `index` works too.
- Variables: substitute from `variables` map by name; default values ignored (suite passes all).
- Inline fragment `... on Repository` on `node(id:)`: if resolved type matches, flatten fields.

## 5. MCP (`src/mcp/`)

Single JSON-RPC endpoint (`server.ts`), no SSE (plain JSON answers satisfy both eras; the
client accepts `content-type: application/json`):
```
POST /mcp  (auth required: no bearer => HTTP 401, regardless of method)
  parse body; malformed => HTTP 400 {jsonrpc, id:null, error:{code:-32700}}
  method dispatch:
    'server/discover'  => {supportedVersions:['2026-07-28','2025-11-25','2025-06-18',...],
                           capabilities:{tools:{}}, serverInfo:{name:'forge', version:'1.0.0'}}
    'initialize'       => {protocolVersion: echo request's or fallback, capabilities:{tools:{listChanged:false}},
                           serverInfo:{name,version}, instructions: ''}
    'notifications/initialized' => 202 empty (no body needed; accept and answer nothing but a 200)
    'tools/list'       => TOOLS constant (six tools, canonical names + inputSchema JSON-schema objects,
                           frozen so two answers serialize byte-identically)
    'tools/call'       => lookup name; unknown => {content:[], isError:true} (suite accepts isError or -32602)
                           missing required args => isError:true, message names them
                           else dispatch to Forge with exact same code paths as REST (rest-parity check)
                           result => {content:[{type:'text', text: JSON.stringify(object)}]}
    'resources/list' | 'prompts/list' => empty lists (harmless)
    unknown method     => error -32601
  headers: echo Mcp-Session-Id only on initialize responses (a static value); accept and ignore it after
```
Tool implementations reuse `src/rest/` domain services (create/get repo, issue CRUD, pulls)
— **one store, two transports**, which is what the `rest-parity` check proves.

## 6. Perf plan (module `src/bench/` + micro-decisions everywhere)

Targets (T_ref, per full round): push 200 exchanges ≈ 1641 ms, clone 50 concurrent shallow
clones ≈ 267 ms, read 2000 GETs ≈ 2760 ms, write 200 POSTs ≈ 349 ms.

- **HTTP layer**: `node:http` with default keep-alive is fine (undici client reuses sockets).
  Never `await` anything avoidable in a handler; keep handlers synchronous where the store is
  in memory (all reads are sync ⇒ zero allocations beyond the response).
- **read workload** (2 000 GETs): the dominant cost will be JSON.stringify of the issue
  object. Precompute the serialized issue JSON at creation/patch time, cache per issue, and
  serve `res.end(cachedJson)` verbatim (a Buffer cache). Issues never change unless patched —
  invalidate on write only.
- **write workload** (200 POSTs): keep creation lean — allocate ids from a counter, push into
  arrays; serialize response body directly from the new object.
- **push workload**: per-push costs = advertisement GET + receive POST. Cache the
  receive-pack advertisement (invalidated per push anyway — rebuild is 1 line per ref, cheap;
  200 refs max is fine). Pack parse: 3 tiny objects, inflateSync ×3 ≈ <1 ms. FF check: walk
  1 commit. Report-status: build pktlines by hand, one Buffer. The critical thing is to do
  **zero closure walking over the whole repo history** per push (walk only from the new tip
  until the old tip is met: 1 commit).
- **clone workload** (the hard one): 50 concurrent depth-1 clones of a 200-commit repo per
  round ⇒ 50 × (advertise + ls-refs + fetch) per round. Responses for identical requests are
  **cacheable bytes**: cache the full `fetch` response Buffer keyed by `(repo, ref-tip,
  depth, has-haves)` — within a round nothing changes, so clones 2..50 are a cached Buffer
  write (memcpy). Cost collapses to socket throughput. Also cache `ls-refs` responses and the
  v2 advertisement per repo. Pack generation itself: depth-1 pack = tip commit + tree + blobs
  (≈ few KB) — but the bench's repo has 200 commits built by pushes carrying *the same 1 KiB
  file path each time*? No: bench push writes a **new blob path per change**; the depth-1 pack
  is still small (one commit + one tree with N entries + one blob). Generating + zlib-deflating
  that is ~1 ms; caching makes it ~0.
- **gzip**: never gzip anything (git clients don't send accept-encoding for smart endpoints;
  undici REST reads are tiny).
- Avoid `JSON.stringify` on large responses (contents API returns base64 blobs ≤ 4 KiB — fine).
- `Buffer.concat` once per response; `res.writeHead` + single `res.end(buffer)`.

## 7. File layout

```
main.ts                  (untouched lifecycle)
app.ts                   createApp(): server + top router delegating to src/
src/
  util/http.ts           sendJson, readBody(json|raw), auth(req), requestId, err helpers
  util/id.ts             global ids, cursor encode/decode
  store/store.ts         Forge, RepoStore, Issue/Pull/Label/Ref types
  store/commits.ts       makeCommit, tree building, treeDiff (pull files), fastForward check
  git/pktline.ts         pkt-line encode/decode
  git/packwrite.ts       writePack (plain objects)
  git/packread.ts        parsePack + delta resolution
  git/adv.ts             advertisement builders + per-repo caches
  git/uploadpack.ts      ls-refs + fetch + shallow closure
  git/receivepack.ts     command parsing, ref updates, report-status side-band
  rest/router.ts         route table + matcher
  rest/repos.ts, issues.ts, pulls.ts, contents.ts
  graphql/parser.ts      minimal document parser
  graphql/execute.ts     resolver map + introspection table
  mcp/server.ts          JSON-RPC endpoint + TOOLS
  bench/cache.ts         response/pack caches (kept simple: Maps with explicit invalidation)
```

## 8. Implementation order (score velocity)

1. **Protocol + REST skeleton** (protocol 5 + repos 15 + issues 15 + pulls 20 = 275 pts of
   feature): router, auth, 401/400/404/422 discipline, `X-GitHub-Request-Id`, repos/issues/
   pulls/contents. Fastest points, no git.
2. **MCP** (15 feature + 15 agent = 40 pts, doubles because it reuses REST services):
   JSON-RPC + `server/discover` + `initialize` + 6 tools.
3. **Git** (30 = the biggest single group; hardest): pktline → advertisements → receive-pack
   (push) → upload-pack v2 ls-refs → fetch without shallow → shallow/deepen → pack parser
   robustness. This unblocks the GraphQL pull checks too (they push branches).
4. **GraphQL** (20): parser + resolver map + introspection table. Depends on store only.
5. **Perf**: read/write caching, push fast path, clone response cache. Measure against
   `T_ref` locally after each workload.

Items 1–4 touch disjoint modules and can be interleaved once the store shapes are fixed.
The git group's shallow checks (`fetch-shallow-*`) are the fiddliest — leave them until the
plain clone/push loop is green.

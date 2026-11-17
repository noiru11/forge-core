# SPEC: make.fun github-core-clone-01 — Git smart-HTTP & REST v3 conformance checks

> Diekstrak dari kit `/tmp/makefun/github-core-clone-01-kit/program/env/src/`
> — `checks-git.ts` (1150 baris, 30 checks), `checks-rest.ts` (1250 baris, 55 checks),
> `git-client.ts` (2144 baris, client protokol), `rest-client.ts` (493 baris, client REST).
> Ini adalah referensi implementasi: apa yang suite kirim, apa yang dianggap lulus, dan
> edge-case-nya. Semua kutipan diambil verbatim dari kode.

---

# BAGIAN A — GRUP GIT (checks-git.ts)

## A.0 Model umum

- Grup `git` berisi tepat **30 CheckSpec** (`GIT_GROUP_SIZE = 30`). Runner memvalidasi jumlahnya
  (`if (GIT_CHECKS.length !== GIT_GROUP_SIZE) throw`).
- Semua check memakai `GitClient` (git-client.ts) — **tidak ada binary git** di trial pod. Penilaian
  murni byte & hash: objek benar bila SHA-1-nya terkomputasi ulang ke id-nya dan kontennya = byte yang
  dipush. Timing tidak pernah mengubah pass/fail.
- Repo dibuat via REST entry: `POST /api/v3/user/repos` (satu-satunya jalur pembuatan; push smart-HTTP
  tidak bisa membuat repo). Nama repo per check: `gitconf-<slug>` di bawah login viewer scenario.
- Harness (per check):
  ```
  client = new GitClient({ baseUrl, token, signal, timeoutMs: min(timeout, DEFAULT_GIT_TIMEOUT_MS=8000) })
  await client.createRepo(owner, repo)   // POST /api/v3/user/repos; 201/200 ok; 422 "already exists" diterima
  ```
- `MAX_DETAIL = 600`: detail result dipotong 600 char + `…`.
- Wrapper `fn` menangkap semua throw → `fail(describeError(err))`; check tidak pernah crash.
  Format error: `GitProtocolError` → `msg [code]`; `GitHttpError` → `msg [HTTP <status>]`; lain →
  `threw <name>: <message>`.
- Konstanta kunci (git-client.ts):
  ```
  ZERO_OID = '0'.repeat(40)
  PKT_LINE_MAX = 65520            // panjang pkt-line (termasuk 4-byte header) maksimum
  PKT_LINE_MAX_PAYLOAD = 65516
  DEFAULT_GIT_TIMEOUT_MS = 8000
  GIT_CLIENT_AGENT = 'makefun-git-client/1.0'
  GIT_OBJECT_FORMAT = 'sha1'
  ```
- Path smart-HTTP: `/<owner>/<repo>.git` (client menambahkan `.git` sendiri):
  ```ts
  repoPath(owner, repo): string  { return `/${owner}/${repo}.git`; }
  ```
  Validasi nama: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/`, repo tidak boleh berakhiran `.git`.
- Auth: header `Authorization: Bearer <token>`. Setiap request `Git-Protocol: version=2` dikirim
  bila meminta v2 (`if (options.gitProtocolVersion === 2) headers['Git-Protocol'] = 'version=2';`).
  `User-Agent: makefun-git-client/1.0`. `redirect: 'error'` — redirect ditolak.

### Model objek & hashing
- `hashObject(type, data)` = SHA-1 atas `<type> <size>\0` + data (loose-object header, tanpa kompresi).
- Tree entries diurutkan: file dulu lalu dir, keduanya lexicographic byte-wise; mode file `100644`,
  dir `40000`.
- Commit dibangun: `tree`, `parent` (0..n), `author`/`committer` = `Name <email> <ts> +0000`,
  message diakhiri `\n` (ditambahkan bila belum). Tag: `object`, `type: commit`, `tag`, `tagger`,
  message + `\n`.
- Pack ditulis (push): `writePack()` — header `PACK` + versi 2 + count (BE32) ×3, tiap objek
  header varint `(type<<4)|(size&0x0f)` + lanjutan `0x80|...`, isi zlib `deflateSync(data)`, trailer
  = SHA-1 atas seluruh byte sebelum trailer. TANPA delta (tidak ada ofs/ref delta yang dikirim).

---

## A.1 Daftar 30 check (urutan registrasi, id = `git.<slug>`)

| # | slug | timeout | judul singkat |
|---|------|---------|---------------|
| 1 | advertise-v2 | 5000 | advertisement v2 utk upload-pack lengkap & valid |
| 2 | advertise-receive-pack | 5000 | advertisement v0 receive-pack + capabilities push |
| 3 | advertise-headers | 5000 | content-type & preamble smart-HTTP (v0, v2, receive-pack) |
| 4 | unknown-repo-404 | 5000 | repo hilang → 404 kedua service; server tetap hidup |
| 5 | ls-refs | 8000 | ls-refs v2: refs, HEAD symref, peeled tag |
| 6 | ls-refs-prefix | 8000 | ref-prefix disaring server-side |
| 7 | clone-empty | 8000 | repo tanpa refs → clone kosong |
| 8 | push-first-commit | 8000 | push pertama ke unborn branch |
| 9 | clone-object-hashes | 12000 | full clone, semua SHA-1 terverifikasi |
| 10 | clone-blob-bytes | 12000 | blob clone byte-identik |
| 11 | clone-tree-entries | 12000 | tree round-trip path/mode/nested dir |
| 12 | clone-commit-bytes | 12000 | commit byte-exact + metadata |
| 13 | clone-annotated-tag | 10000 | tag object round-trip + peel |
| 14 | fetch-incremental | 12000 | fetch incremental kirim hanya objek baru |
| 15 | fetch-nothing-new | 10000 | fetch dgn tip sudah dipegang → 0 objek |
| 16 | fetch-shallow-depth1 | 12000 | depth-1 shallow clone: tip saja |
| 17 | fetch-shallow-deepen | 12000 | deepen 2 = tepat satu generasi |
| 18 | fetch-shallow-new-tip | 12000 | shallow fetch tip baru tidak menarik sejarah lama |
| 19 | push-update-ref | 10000 | fast-forward update |
| 20 | push-create-branch | 10000 | buat branch dari commit ada |
| 21 | push-delete-branch | 10000 | hapus branch |
| 22 | push-non-fast-forward | 10000 | non-FF ditolak per-ref, tanpa perubahan |
| 23 | push-mixed-report | 12000 | satu command list: ok + ng per ref |
| 24 | push-delete-tag | 10000 | hapus tag ref |
| 25 | push-100-files | 15000 | push 1 commit 100 file byte-exact |
| 26 | pack-integrity | 12000 | pack terstruktur valid + checksum |
| 27 | pack-deltas | 15000 | objek delta ter-resolve benar |
| 28 | sideband-framing | 12000 | section packfile = sideband framing valid |
| 29 | push-sideband-report | 12000 | report push tiba dalam frame sideband |
| 30 | repo-survives-errors | 15000 | server sehat lewat 404, refusal, POST malformed |

---

## A.2 Protokol persis yang suite kirim

### A.2.1 HTTP-level
- **GET** `/{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack`
  - Header: `Accept: */*`; tambahan `Git-Protocol: version=2` untuk upload-pack kecuali client
    dipaksa v0 (`gitProtocol: 0`). receive-pack TIDAK PERNAH minta v2
    (`service !== 'git-upload-pack' || protocolPreference === 0 ? null : 2`).
  - Content-Type 200 yang diharapkan: `application/x-git-upload-pack-advertisement` /
    `application/x-git-receive-pack-advertisement` (`expectedType = application/x-${service}-${kind}`).
- **POST** `/{owner}/{repo}.git/{service}` (`git-upload-pack` atau `git-receive-pack`)
  - `Content-Type: application/x-${service}-request`
  - `Accept: application/x-${service}-result`
  - Response HARUS 200 dan content-type mengandung `application/x-${service}-result`, else
    GitHttpError/GitProtocolError.

### A.2.2 Pkt-line (framing dasar)
- Data packet: 4 byte hex length (payload+4, lowercase? client menulis `padStart(4,'0')` dari
  `toString(16)`), lalu payload. Maks payload 65516.
- `0000` = flush-pkt, `0001` = delim-pkt, `0002` = response-end, `0003` = INVALID (decoder throw
  `'invalid pkt-line length 0003'`). Length > 65520 → error `'pktline-too-long'`. Byte pertama
  bukan hex4 → error; truncated stream setelah finish → error (tidak pernah data hilang senyap).
- `PktLineDecoder` inkremental; `decodePktLines(bytes, {allowTrailing})` untuk v0 raw fallback
  (`nextIsRaw()` true bila 4 byte berikut BUKAN hex4 → sisa dianggap raw pack data tanpa framing).

### A.2.3 Advertisement parsing
- Skip baris pertama `# service=...` bila ada (opsional).
- v2: baris pertama `version 2`, lalu capability lines `key=value` atau `key`. Jika
  `object-format` ada dan ≠ `sha1` → error.
- v0: baris `<oid> <ref>`; capability setelah NUL (`\u0000`) pada baris PERTAMA.
  `capabilities^{}` pseudo-ref dilewati; nama berakhiran `^{}` = peeled dari tag (digabung ke
  ref dasarnya). oid == ZERO_OID → ref `unborn: true`. HEAD symref dibaca dari capability
  `symref=HEAD:<target>` → `symrefTarget`.

### A.2.4 v2 ls-refs (request yang dikirim)
```
command=ls-refs\n
agent=makefun-git-client/1.0\n        (bila server advertise 'agent')
object-format=sha1\n                  (bila server advertise 'object-format')
<delim>
peel\n                                (default ON — dikirim kecuali options.peel===false)
symrefs\n                             (default ON)
unborn\n                              (hanya bila capability ls-refs memuat token 'unborn')
ref-prefix <p>\n                      (untuk tiap prefixes[])
<flush>
```
- Parsing respons: tiap data-packet = `line` (`\n` di-strip). Format:
  `<oid> <name> [symref-target:<t>] [peeled:<oid>]`; baris unborn: `unborn <name> ...`.
  Token di-parse dengan prefix `symref-target:` / `peeled:`.
- Result: `rawRefs` (semua yang server kirim, SEBELUM filter client) dan `refs` (setelah filter
  prefix client-side). Check `ls-refs-prefix` menegaskan server-side filtering: setiap nama di
  `rawRefs` harus match prefix — jadi server WAJIB menfilter berdasarkan `ref-prefix`, bukan
  mengirim semua.

### A.2.5 v2 fetch (request yang dikirim)
```
command=fetch\n
agent=...\n                            (bila ada)
object-format=sha1\n                   (bila ada)
<delim>
thin-pack\n                            (kecuali request.thinPack===false)
no-progress\n                          (kecuali request.noProgress===false)
ofs-delta\n                            (SELALU)
filter <spec>\n                        (bila request.filter; server harus advertise fetch=filter,
                                        else error 'fetch-filter')
want <oid>\n                           (untuk tiap want, dedup; harus 40-hex, else 'fetch-want')
have <oid>\n                           (tiap have)
shallow <oid>\n                        (boundary shallow client, validasi 40-hex)
deepen <n>\n                           (bila request.depth; server harus advertise fetch=shallow,
                                        else error 'fetch-shallow')
deepen-since <ts>\n / deepen-not <ref>\n (bila ada)
done\n                                 (SELALU kecuali request.done===false)
<flush>
```
Urutan dalam kode: thin-pack, no-progress, ofs-delta, filter, wants, haves, shallows, deepen,
deepen-since, deepen-not, done, flush. Perhatikan `have` datang SEBELUM `shallow/deepen` pada v2
(beda dengan v0, lihat bawah).

- Respons v2 di-parse per-section. Nama section (data-packet berisi persis text+\n):
  `acknowledgments\n`, `shallow-info\n`, `wanted-refs\n`, `packfile\n`, `packfile-uris\n`.
  flush/delim reset section ke ''. Section tak dikenal → error `'fetch-section'`.
  - `acknowledgments`: `NAK`, `ready`, atau `ACK <oid>`.
  - `shallow-info`: `shallow <oid>` / `unshallow <oid>`.
  - `wanted-refs`: `<oid> <ref>`.
  - `packfile`: setiap data-packet adalah sideband: byte[0] = band. band 1 → data pack
    (dikumpulkan); band 2 → progress text; band 3 → throw `'sideband-error'`; band lain →
    `'sideband'`. Packet kosong di packfile → error.
- Setelah stream: jika section terakhir `packfile` dan 0 sideband packet → error
  `'packfile section carried no packets'`.
- Pack yang terkumpul: `verifyPackChecksum` (trailer SHA-1 20 byte terakhir vs SHA-1 seluruh
  byte sebelum trailer); gagal → throw `'pack-checksum'`. Kemudian `readPack` (kecuali
  `parse:false`) dengan `resolveBase` dari `haveObjects` (untuk REF_DELTA thin pack).

### A.2.6 v0 fetch
- Wajib server advertise `side-band-64k`, else error `'v0 server does not advertise side-band-64k,
  so a fetch cannot be framed'`.
- Capabilities yang dikirim pada baris `want` PERTAMA: `side-band-64k` selalu; +
  `multi_ack_detailed` (atau `multi_ack`) bila advertised; `thin-pack` bila advertised dan
  diminta; `no-progress`; `ofs-delta` bila advertised.
- Framing DUA section (komentar kode penting):
  ```
  // v0 is two sections: wants (with shallow/deepen) terminated by a flush, then the negotiation
  // (have lines and done) terminated by a second flush. A single section is a v2 shape and makes
  // upload-pack answer "expected to get object ID, not 'done'".
  want <oid> <caps>\n  (pertama; sisanya `want <oid>\n`)
  shallow <oid>\n      (bila ada)
  deepen <n>\n         (bila depth; server harus advertise 'shallow', else error)
  deepen-since/deepen-not (bila ada)
  <flush>
  have <oid>\n ...
  done\n               (kecuali done===false)
  <flush>
  ```
- Respons v0: paket yang byte[0] ∈ {1,2,3} = sideband (band 1 data, 2 progress, 3 error).
  Packet teks lain: `shallow <oid>`, `unshallow <oid>`, `NAK`, `ACK <...>`; lainnya → error
  `'unexpected v0 fetch packet'`.

### A.2.7 Clone
- `advertisement(git-upload-pack)` dulu. v2 → `lsRefs({peel:true, symrefs:true})`; v0 → pakai
  advertisement langsung. `head` = symref HEAD (atau null).
- Wants: default (bukan shallow/singleBranch) = semua `refs/heads/*` dan `refs/tags/*` dgn oid
  ≠ ZERO_OID. Shallow/singleBranch: hanya tip HEAD (symref) atau head branch pertama; bila tidak
  ada tip & bukan shallow → semua refs/heads.
- `fetch({ wants, depth, parse })`.
- Empty repo (0 wants) → hasil kosong tanpa POST fetch sama sekali (tidak ada HTTP kedua).

### A.2.8 Push (receive-pack v0)
- `advertisement(git-receive-pack)` HARUS protocol v0 (`'receive-pack must advertise protocol v0'`).
- Validasi command: old/new 40-hex; ref harus `refs/`-prefixed, ≤200 char, tanpa whitespace
  atau `\u0000-\u001f`.
- Capabilities yang dikirim (pada command PERTAMA, setelah NUL):
  - `report-status-v2` bila advertised, else `report-status` bila advertised
  - `side-band-64k` bila advertised
  - `ofs-delta` bila advertised
  - `agent=makefun-git-client/1.0` bila advertised
- Framing command:
  ```
  <oldOid> <newOid> <ref>\0<caps joined ' '>\n     (command pertama, bila caps tak kosong)
  <oldOid> <newOid> <ref>\n                        (sisanya)
  <flush>
  ```
  diikuti PACK bytes (concat langsung setelah flush). Komentar kode penting:
  ```
  // A receive-pack command list that creates or updates a ref always carries a pack, even an empty
  // one: real git's receive-pack reports "unpacker error" for a bare command list. A delete-only
  // command list carries no pack at all (git sends none there either).
  ```
  Jadi: ada command dgn newOid ≠ ZERO_OID → kirim pack (dari `objects` via writePack, atau
  `options.pack` mentah). Delete-only (semua newOid == ZERO_OID dan objects kosong) → TANPA pack.
- Respons: pkt-line stream; bila side-band-64k di-request, demux band 1 → report bytes,
  band 2 → progress, band 3 → throw. Report bytes di-parse `parsePushReport`:
  - Bila 4 byte pertama hex4 → report itu sendiri pkt-lined (di dalam band 1); decode dulu.
  - Lines: `unpack ok` / `unpack <detail>`; `ok <ref>`; `ng <ref> <reason>`; `option <k>[ <v>]`
    (report-status-v2, terlampir ke ref terakhir). Line lain → error `'push-report'`.
  - Tanpa baris `unpack` → error `'report-status has no unpack line'`.
- Push DITOLAK bukan exception: HTTP 200 + `ng` line = exchange sukses dengan update ditolak.

### A.2.9 POST raw (untuk repo-survives-errors)
`postRaw(owner, repo, 'git-upload-pack', Buffer.from('zzzznot-a-pkt-line','ascii'))` — headers
service request/result normal, respons TIDAK divalidasi (status apapun diterima; yang dicek adalah
kesehatan server SETELAHNYA).

---

## A.3 Spec per check (request & pass criteria)

Setup umum: `repoWithInitialCommit` = harness + 1 commit (file scenario[0], meta scenario[0])
dipush ke `refs/heads/main` (create dari unborn, oldOid=ZERO_OID). Setup gagal = fail dgn detail
`setup push to <repo> failed: <pushFailure>`.

`pushFailure(result)`:
- `!result.report` → `'the server returned no report-status (it did not advertise report-status)'`
- `!unpackOk` → `unpack failed: <unpackDetail>`
- ref `!ok` → `<ref>: <reason>` (join `; `)

### 1. git.advertise-v2
- Setelah setup, `advertisement(owner, repo, 'git-upload-pack')` (client default `auto` → kirim
  `Git-Protocol: version=2`).
- PASS jika `advertisement.protocol === 2`; capabilities memuat `fetch` dan `ls-refs`;
  bila `object-format` ada nilainya `sha1`.
- Gagal v0 → "the server answered protocol v0; the rules require Git-Protocol: version=2 to be
  honoured".

### 2. git.advertise-receive-pack
- `advertisement(owner, repo, 'git-receive-pack')`. PASS jika:
  - protocol === 0 (receive-pack v0-only);
  - advertisement memuat `refs/heads/main` di oid = tip setup;
  - capabilities memuat `report-status`, `side-band-64k`, `delete-refs` (ketiganya wajib).

### 3. git.advertise-headers
- Tiga GET info/refs: upload-pack dengan client v0 (`gitProtocol: 0`), upload-pack dengan v2,
  receive-pack. PASS jika masing-masing: status 200 dan content-type memuat
  `application/x-git-upload-pack-advertisement` / `application/x-git-receive-pack-advertisement`.
- Preamble: data packet pertama (payload, strip `\n`):
  - v0 upload: `# service=git-upload-pack` ATAU `version 2` (server boleh jawab v2 walau diminta v0
    pada check ini — tapi receive wajib `# service=git-receive-pack`).
  - v2 upload: `# service=git-upload-pack` (v0 fallback, ditoleransi di sini) ATAU `version 2`.
  - receive: persis `# service=git-receive-pack`.

### 4. git.unknown-repo-404
- info/refs upload-pack dan receive-pack untuk `<repo>-missing` → keduanya status 404.
- Lalu info/refs upload-pack repo asli → 200 (server tidak mati).

### 5. git.ls-refs
- Setup: commit kedua di main + tag annotated `v1` ke commit kedua; keduanya dipush.
- `lsRefs(owner, repo, { symrefs: true, peel: true })`. PASS jika:
  - protocol 2;
  - `refs/heads/main` = oid commit kedua;
  - HEAD punya `symrefTarget === 'refs/heads/main'`;
  - `refs/tags/v1` oid = tag object dan `peeled` = commit kedua.

### 6. git.ls-refs-prefix
- Setup: push tag `v1` (repo main sudah ada dari initial commit).
- Tiga ls-refs: prefixes `['refs/heads/']`, `['refs/tags/']`, `['refs/does-not-exist/']`.
- PASS: semua rawRefs pada panggilan heads berawalan `refs/heads/`, memuat main@tip; rawRefs tags
  berawalan `refs/tags/`, memuat v1; prefix tak cocok → `rawRefs.length === 0`.
  (rawRefs adalah data SEBELUM filter client — membuktikan server yang menfilter.)

### 7. git.clone-empty
- Harness tanpa push. Ambil refs (ls-refs bila v2, else advertisement). Tidak boleh ada ref
  berawalan `refs/`. `clone()` → `objects.size === 0` dan TIDAK ada pack non-empty
  (`pack === null || packBytes === 0`).

### 8. git.push-first-commit
- Push `{ oldOid: ZERO_OID, newOid: tip, ref: 'refs/heads/main' }` ke repo baru.
- PASS: `report.unpackOk === true`; `reportFor('refs/heads/main').ok`; ls-refs menunjukkan
  `refs/heads/main` = tip dan HEAD symref = `refs/heads/main` (HEAD harus resolve setelah push pertama).

### 9. git.clone-object-hashes
- 3 commit di main. `clone()` penuh. PASS: tidak ada hash mismatch (semua objek SHA-1 valid),
  tip ada, closure dari tip lengkap (`missingClosure` = collectReachable tidak melempar
  'missing-object'), dan SETIAP objek reachable (dari local) ada di clone.

### 10. git.clone-blob-bytes
- 2 commit, blob pertama 4096 byte (scenarioSizedFile). Clone. PASS: tak ada objek reachable yang
  hilang, tak ada yang berbeda byte-for-byte.

### 11. git.clone-tree-entries
- File termasuk nested path (dipaksa `src/...` bila blob scenario tidak mengandung `/`).
- Clone; parse commit tip → root tree → parseTree. PASS: nama root entries = first-segments
  file paths; dir entry mode `40000`; isi sub-tree sesuai; semua objek byte-identik.

### 12. git.clone-commit-bytes
- Commit kedua dengan revision meta (message `\n\nrevision 3`, timestamp +3). Clone.
- PASS: byte commit identik; parents = [tip]; message exact; author & committer memuat
  `<ts> +0000` dan email viewer.

### 13. git.clone-annotated-tag
- Push tag `refs/tags/v1` (annotated). Clone → tag object ada, byte-identik; parseTag:
  `object`=tip, `type`='commit', `tag`='v1', tagger memuat email viewer.
- ls-refs `peel:true` → refs/tags/v1 oid = tag, peeled = tip.

### 14. git.fetch-incremental
- Clone pertama; push commit kedua; `fetch({ wants:[second], haves:[tip], haveObjects: clone.objects })`.
- PASS: `second` delivered; `tip` TIDAK dikirim ulang; semua objek hash-valid; setiap objek baru
  (reachable dari second, bukan dari tip) delivered; TIDAK ada objek lama yang dikirim ulang.

### 15. git.fetch-nothing-new
- `fetch({ wants:[tip], haves:[tip], haveObjects: clone.objects })` → `objects.size === 0`.
  (Pack mungkin ada tapi 0 entri.)

### 16. git.fetch-shallow-depth1
- 3 commit; `clone({ depth: 1 })`. PASS:
  - tip ada; parent & grandparent TIDAK ada;
  - byte tip commit identik; tree tip ada; semua blob di tree tip ada;
  - `shallow.shallow` MEMUAT tip (server harus mengirim `shallow <tip>` di shallow-info/v0).

### 17. git.fetch-shallow-deepen
- 3 commit; clone depth 1; lalu
  `fetch({ wants:[third], haves:[third], shallow: shallow.shallow, depth: 2, haveObjects: shallow.objects })`.
- PASS: parent (`second`) delivered byte-identik beserta tree-nya; grandparent TIDAK delivered;
  boundary bergeser: `deepened.shallow` memuat `second` ATAU `deepened.unshallow` memuat `third`.

### 18. git.fetch-shallow-new-tip
- 2 commit; clone depth 1 (di second); push third; 
  `fetch({ wants:[third], haves:[second], shallow: shallow.shallow, depth: 1, haveObjects: ... })`.
- PASS: third delivered; `tip` (grandparent) TIDAK; `second` (sudah dipegang) TIDAK dikirim ulang.

### 19. git.push-update-ref
- Push FF `{oldOid: tip, newOid: second, ref: refs/heads/main}`. PASS: unpackOk, ref ok,
  ls-refs main = second, clone melihat second.

### 20. git.push-create-branch
- Push `{ZERO_OID, tip, refs/heads/feature}`. PASS: unpackOk + ref ok; ls-refs memuat feature@tip;
  clone.refs memuat feature@tip.

### 21. git.push-delete-branch
- Buat feature, lalu delete `{oldOid: tip, newOid: ZERO_OID, ref: refs/heads/feature}`.
- PASS: unpackOk delete; ref ok; ls-refs TIDAK memuat feature lagi; main utuh; repo masih clonable.

### 22. git.push-non-fast-forward
- main@second; lalu push langsung (bukan via pushRefs) `{oldOid: second, newOid: sibling, ref:
  refs/heads/main}` dengan SEMUA objek reachable sibling (sibling parent-nya tip, bukan second).
- PASS: `unpackOk === true` (pack update yang ditolak TETAP harus ter-unpack);
  report untuk main: `ok === false` dan `reason === 'non-fast-forward'` (string persis);
  main masih second; info/refs 200; clone utuh.

### 23. git.push-mixed-report
- Setup main@second + refs/heads/side@second. Satu push dua command:
  `{second→forward, refs/heads/main}` (FF) dan `{second→sibling, refs/heads/side}` (non-FF).
- PASS: unpackOk; main ok; side `!ok` dgn reason `non-fast-forward`;
  `report.refs.length === 2` (satu line per command, urutan/jumlah tepat); main maju ke forward;
  side tetap second.

### 24. git.push-delete-tag
- Buat refs/tags/v1 lalu delete. PASS: unpackOk, ref ok, ls-refs tanpa refs/tags/v1.

### 25. git.push-100-files
- 1 commit berisi 100 file (`scenarioManyFiles(scenario, 100, 1)`; path round-robin dengan suffix
  `.1`, `.2`... di sebelum ekstensi). Push ke unborn main.
- PASS: unpackOk; ref ok; clone; semua objek reachable ada & byte-identik; TIAP path 100 file
  resolve di tree dan blob-nya byte-identik.

### 26. git.pack-integrity
- 2 commit (blob 2048 byte). `fetch({ wants:[second], parse: false })` — raw pack.
- PASS: pack ada; `verifyPackChecksum(pack).ok` (trailer = SHA-1 sebelum trailer);
  `readPack`: `declaredCount === entries.length`, `objects.size === declaredCount`
  (tidak ada duplikat/stray), version 2 atau 3; semua objek hash-valid.

### 27. git.pack-deltas
- Blob 20000 byte direvisi 3× (mendorong server untuk delta). Clone.
- PASS: tip ada; semua objek (termasuk hasil delta) hash-valid; tidak ada objek reachable yang
  berbeda byte. NB delta opsional: `clone.deltaCount` hanya dilaporkan, minimal 0 — check lulus
  juga bila server tidak mengirim delta, asalkan hasilnya benar.

### 28. git.sideband-framing
- Blob 4096, 2 commit. `fetch({ wants:[second], parse:false, observe: pkt => packets.push(pkt) })`.
- Reimplementasi manual: memindai section `packfile\n` (juga `acknowledgments\n`,
  `shallow-info\n`, `wanted-refs\n` dikenali sebagai section kontrol; v0 tanpa section names —
  packet dgn band 1/2/3 langsung diterima). Per packet:
  - `packet.raw.length > PKT_LINE_MAX (65520)` → fail (framing header melebihi batas);
  - band 1 → kumpulkan payload[1..]; band 2 → hitung progress bytes; band 3 → FAIL (server
    sideband error); band lain → FAIL `invalid sideband band`.
- PASS: ≥1 sideband packet di packfile; ≥1 byte band-1; reassembled pack lulus checksum dan
  readPack.

### 29. git.push-sideband-report
- Push FF biasa. PASS: `pushed.sideband === true` (server HARUS melayani side-band-64k utk
  receive-pack bila di-request); report ter-demux dari band 1 dengan `unpackOk` dan ref ok.

### 30. git.repo-survives-errors
- Rangkaian: info/refs repo missing → 404; push FF ok; push non-FF probe (verdict bebas —
  diterima atau `ng` keduanya survivable); POST malformed body `zzzznot-a-pkt-line` ke
  `/{owner}/{repo}.git/git-upload-pack` (status apapun dicatat); lalu:
  - info/refs repo asli → 200;
  - ls-refs: refs/heads/main masih ada;
  - clone: tip advertised ada, semua objek hash-valid, closure lengkap.

---

# BAGIAN B — REST v3 (checks-rest.ts)

## B.0 Model umum

- Grup: `repos` (15), `issues` (15), `pulls` (20), dan 5 check `protocol` (sisanya 5 check
  protocol lain ada di modul lain). Total 55 check di file ini.
- Klien: `RestClient` (rest-client.ts). Semua path di bawah prefix `API_PREFIX = '/api/v3'`.
- Headers default tiap request: `accept: application/vnd.github+json`; `authorization: Bearer
  <token>` bila token ada; `content-type: application/json` untuk body JSON. Timeout per call
  default 5000ms (check pakai `max(1000, min(timeout, 5000))`).
- Dua klien per check: `client` (token viewer) dan `anon` (tanpa token) untuk check 401.
- Skenario `restScenarioOf(scenario)`: owner=viewer.login, otherOwner=stranger.login,
  repoPrefix=scenario.repos[0].name, paginationRepos=30 nama repo seeded, filePath/blob konten
  dari blobs, commitMessage, branchName (bukan default branch), issue/pull/label text,
  description + descriptionAlt (`... (updated)`), badLabel = `<label>-not-a-label`.
- Nama repo per check: `<repoPrefix>-<slug(id)>` (slug: lowercase, non `[a-z0-9._-]` → `-`),
  dipotong 100 char.
- `expectJsonResponse(resp, expectedStatus(es), shape, label)`: status PERSIS (bukan range),
  content-type JSON (regex `^application/(?:[A-Za-z0-9!#$&^_.+-]+\+)?json(?:\s*;.*)?$`), bukan
  HTML (`expectNoHtml`: content-type text/html atau body berawalan `<`), body JSON valid, dan
  shape cocok. Gagal = string detail human.
- Konstanta: `SHA40 = /^[0-9a-f]{40}$/i`; error body shape: `{ message: nonEmpty string }`.
- Ownership edge case PENTING (komentar header):
  ```
  // Ownership: a repository belongs to the login the token names, so the same repository name
  // under another seeded login is 404 (never 403), and a request with no token is 401.
  ```
- Kontrak protokol (header komentar file):
  ```
  GET    /api/v3/                200, JSON, X-OAuth-Scopes header
  GET    /api/v3/meta            200, {"installed_version": string}
  POST   /api/v3/user/repos      201 {name, private, default_branch, ...}
  GET    /api/v3/repos/{o}/{r}   200 {name, private, default_branch, description}; 404 {"message"} bila absen
  PATCH  /api/v3/repos/{o}/{r}   200, description terupdate
  DELETE /api/v3/repos/{o}/{r}   204, hilang setelahnya (404)
  GET    /api/v3/user/repos?per_page=10   200 list, Link: <...>; rel="next"
  POST   /api/v3/repos/{o}/{r}/git/refs   201 {ref, object:{sha}}
  GET    /api/v3/repos/{o}/{r}/branches   200 [{name, commit:{sha}}]
  GET    /api/v3/repos/{o}/{r}/commits[?sha=<ref>]  200 [{sha, commit:{message}}]
  PUT    /api/v3/repos/{o}/{r}/contents/{path}  201 {content:{sha, encoding}, commit:{sha}}
                                                200 on update, 409 on a stale sha
  GET    /api/v3/repos/{o}/{r}/contents/{path}[?ref=]  200 file {encoding:"base64", content, sha, size}
                                                atau array listing bila direktori
  DELETE /api/v3/repos/{o}/{r}/contents/{path}  200 {commit:{sha}}, 404 setelahnya
  POST   /api/v3/repos/{o}/{r}/labels   201 {name, color}
  POST   /api/v3/repos/{o}/{r}/issues   201 {number, title, body, state, labels}; 422 label tak dikenal
  GET    /api/v3/repos/{o}/{r}/issues?state=&sort=  200 list difilter & tersortir
  GET    /api/v3/repos/{o}/{r}/issues/{n}  200 satu issue
  PATCH  /api/v3/repos/{o}/{r}/issues/{n}  200, {state:"closed"} menutup
  POST   /api/v3/repos/{o}/{r}/issues/{n}/comments  201 {id, body}
  GET    /api/v3/repos/{o}/{r}/issues/{n}/comments  200 list
  POST   /api/v3/repos/{o}/{r}/pulls    201 {number, state:"open", head, base}
  GET    /api/v3/repos/{o}/{r}/pulls?state=all  200 list
  GET    /api/v3/repos/{o}/{r}/pulls/{n}  200 satu pull; 404 unknown
  GET    /api/v3/repos/{o}/{r}/pulls/{n}/files  200 [{filename, status, additions, ...}]
  PUT    /api/v3/repos/{o}/{r}/pulls/{n}/merge  200 {sha, merged:true, message}
                                                404 unknown PR, 405 conflicted PR
  ```
  ```
  // Protocol: every reply is application/json (never HTML), an unknown route is a JSON 404, a
  // malformed JSON request body is a 400, every reply carries a non-empty X-GitHub-Request-Id
  // header, and no X-RateLimit-* header is required.
  ```

## B.1 Fixture bersama

- `prepareRepo(set, id, {private?, description?, filePath?, content?})`:
  1. `POST /api/v3/user/repos` body `{name, private: true (default), description}` → wajib 201,
     shape `{name (== name), private: boolean}`.
  2. `PUT /api/v3/repos/{o}/{r}/contents/<filePath>` body `{message, content: b64(content)}`
     → wajib 201, shape `contentCommitShape = {content: {sha: SHA40, encoding: 'base64'},
     commit: {sha: SHA40}}`.
  3. `GET /api/v3/repos/{o}/{r}` → 200, baca `default_branch`.
  Return `RepoRef{owner, name, path, defaultBranch, initialCommitSha}`.
- `putContent(set, repo, {filePath, content, message, branch?, sha?})` — body JSON
  `{message, content: b64encode(content), [branch], [sha]}` ke
  `PUT /api/v3/repos/{o}/{r}/contents/<path>`.
- `getContent(..., ref?)` — `GET .../contents/<path>[?ref=<ref>]` → shape
  `{type:'file', encoding:'base64', content: string, sha: SHA40, size: int≥0}`.
- `createBranch(set, repo, branch, sha)` — `POST .../git/refs` body `{ref: "refs/heads/<branch>",
  sha}` → 201 shape `{ref: "refs/heads/<branch>", object: {sha: SHA40}}`.
- `commitOnBranch(...)` — PUT contents dengan `branch`; update kirim `sha` blob lama; status
  diterima: 201 (create) atau `[200, 201]` (update).
- `preparePull(set, id, files?)`: prepareRepo → createBranch head di initialCommitSha → commit
  1..n file di head branch (path default `variantPath(filePath, slug)` — suffix `-slug` sebelum
  ekstensi) → `POST .../pulls` `{head, base: defaultBranch, title, body}` → 201 pullShape.
- `pullShape = {number: int≥1, state: 'open'|'closed', title: string, body: string,
  head: {ref nonEmpty, sha SHA40}, base: {ref nonEmpty, sha SHA40}}`.
- `issueShape = {number int≥1, title, body, state 'open'|'closed', labels: [{name nonEmpty}]}`.
- `pullFileShape = {filename nonEmpty, status nonEmpty, additions int≥0, deletions int≥0,
  changes int≥0}`.
- `mergePull` = `PUT .../pulls/<n>/merge` body `{merge_method: 'squash'}` (SELALU squash).
- `prepareIssueRepo` = prepareRepo + `POST .../labels` body `{name: label, color: 'ededed'}`
  → 201 `{name}`.

## B.2 repos (15)

1. **repos.pagination** — `GET /user/repos pages 30 seeded repos at per_page=10 through Link
   rel="next"`. Buat 30 repo seeded (`POST /user/repos`; 201 atau 422 jika sudah ada — diterima;
   status lain fail), verifikasi tiap repo GET 200. Lalu ikuti rantai `Link` mulai
   `GET /api/v3/user/repos?per_page=10`: tiap halaman 200 JSON array; ≤10 item per halaman;
   `rel="next"` harus same-origin (kalau keluar origin → fail); rantai selesai ≤20 halaman;
   nama unik (tidak boleh ada duplikat lintas halaman); ke-30 nama seeded semua muncul;
   ≥3 halaman.
   Parser Link: `/<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/` per elemen dipisah koma.
2. **repos.root** — `GET /api/v3/` → 200 JSON object (loose) + header `x-oauth-scopes` ADA.
3. **repos.meta** — `GET /api/v3/meta` → 200 `{installed_version: nonEmpty string}`.
4. **repos.create** — POST /user/repos (private true) → 201 `{name, private}` dan
   `private === true`; GET repo → 200 `{name, private, default_branch nonEmpty}` dengan name &
   private cocok; GET kedua → `default_branch` STABIL (tidak berubah antar baca).
5. **repos.not-found** — `GET /api/v3/repos/{owner}/<repoPrefix>-never-created` → 404
   `{message: nonEmpty}`.
6. **repos.patch** — `PATCH {repo.path}` body `{description: descriptionAlt}` → 200
   `{description == descriptionAlt}`; GET berikutnya juga descriptionAlt.
7. **repos.delete** — `DELETE {repo.path}` → 204 (tanpa syarat body); GET setelahnya → 404.
8. **repos.branches** — createBranch `<branchName>-branches` di initialCommitSha;
   `GET .../branches` → 200 array `{name nonEmpty, commit:{sha SHA40}}`; memuat branch baru DAN
   default branch; sha branch baru == initialCommitSha (case-insensitive).
9. **repos.commits** — createBranch + commit file di branch; `GET .../commits?sha=<branch>` →
   200 array `{sha SHA40, commit:{message}}`; memuat commit baru dgn message persis
   `<commitMessage> (<slug>)`; `GET .../commits` (default branch) TIDAK memuat sha itu
   (belum merge).
10. **repos.unauthorized** — `GET {repo.path}` TANPA token → 401 `{message}`.
11. **repos.foreign-token** — repo dibuat di bawah owner; `GET /api/v3/repos/<otherOwner>/<name>`
    (nama sama di bawah stranger) → **404, bukan 403**, `{message}`.
12. **repos.contents-create** — PUT contents path baru → 201; GET → content dekode ==
    byte yang dikirim; sha == content.sha dari PUT; size == byteLength utf8.
13. **repos.contents-directory** — repo dibuat dgn file `<dirPath>/seed.txt`; tambah
    `one.txt`, `two.txt` di dir yang sama; `GET .../contents/<dirPath>` → 200 ARRAY entries
    `{type: 'file'|'dir', name nonEmpty, path nonEmpty, sha SHA40}`; memuat ketiga nama.
14. **repos.contents-stale-sha** — GET sha saat ini; PUT update dgn sha itu → 200 ATAU 201 dan
    content sha BERUBAH; PUT kedua dgn sha lama yang sama (stale) → **409** `{message}`.
15. **repos.contents-delete** — `DELETE .../contents/<path>` body `{message, sha}` → 200
    `{commit:{sha SHA40}}`; GET setelahnya → 404.

## B.3 issues (15)

Semua pakai `prepareIssueRepo` (repo + label `POST /labels {name, color:'ededed'}` → 201).

1. **issues.create** — `POST .../issues` `{title, body, labels:[label]}` → 201 issueShape,
   `state === 'open'`.
2. **issues.create-title-body** — echo title & body persis.
3. **issues.create-labels** — `body.labels[].name` memuat label.
4. **issues.numbers-increment** — dua issue berturut-turut: `number2 === number1 + 1` (tepat +1).
5. **issues.list-open** — buat open + closed (PATCH close); `GET .../issues?state=open&per_page=100`
   → memuat open; tiap item `state === 'open'`.
6. **issues.list-open-excludes-closed** — issue closed TIDAK muncul di state=open.
7. **issues.list-sort-asc** — 3 issue; `?state=open&sort=created&direction=asc&per_page=100`
   → ketiganya ada dan posisi menaik sesuai urutan create.
8. **issues.list-sort-desc** — sama, `direction=desc` → posisi terbalik (terbaru dulu).
9. **issues.list-shape** — `?state=open&per_page=10` → array tak kosong, tiap item cocok
   `issueShape` penuh.
10. **issues.get-one** — `GET .../issues/<n>` → 200 issueShape; number, title, body cocok.
11. **issues.patch-close** — `PATCH .../issues/<n>` body `{state:'closed'}` → 200
    `{number int≥1, state === 'closed'}`.
12. **issues.patch-close-persists** — setelah close, GET → `state === 'closed'`.
13. **issues.comment-create** — `POST .../issues/<n>/comments` body `{body: commentBody}` → 201
    `{id: int≥1, body == commentBody}`.
14. **issues.comments-list** — POST comment, ambil id; `GET .../issues/<n>/comments` → 200 array
    `{id int≥1, body}`; memuat id & body itu.
15. **issues.bad-label** — `POST .../issues` dgn `labels: [badLabel]` (tidak pernah dibuat) →
    **422** `{message}`.

## B.4 pulls (20)

1. **pulls.create** — preparePull; `GET .../pulls/<n>` → 200 pullShape; state open; head.ref ==
   head branch; base.ref == defaultBranch.
2. **pulls.create-body** — title & body echo persis.
3. **pulls.create-head-sha** — `head.sha == headCommitSha` (tip head branch setelah commit).
4. **pulls.create-base-sha** — `base.sha == repo.initialCommitSha` (base belum bergerak).
5. **pulls.get-one** — number & title cocok.
6. **pulls.files-list** — `GET .../pulls/<n>/files` → 200 array pullFileShape; memuat path yang
   diubah; statusnya ∈ {'added','modified','changed'}; `additions ≥ 1`.
7. **pulls.files-shape** — ≥1 file, semua cocok pullFileShape.
8. **pulls.files-multiple** — PR dgn 2 file (`multi-a`, `multi-b`); kedua filename terdaftar.
9. **pulls.merge-status** — PUT merge (squash) → 200.
10. **pulls.merge-body** — body `{merged: boolean === true, sha: SHA40, message: string}`.
11. **pulls.merge-closes** — setelah merge, `GET .../pulls/<n>` → 200
    `{state === 'closed', merged: boolean === true, merged_at: nonEmpty string}`.
12. **pulls.merge-commit-on-default** — `GET .../commits?sha=<base>` memuat merge sha.
13. **pulls.merge-content-on-default** — `GET contents/<changedPath>?ref=<base>` dekode ==
    `fileContentAlt` (konten squash benar-benar di default branch).
14. **pulls.merge-commit-sha** — GET pull setelah merge → `{merge_commit_sha: SHA40}` ==
    merge sha (lowercase compare).
15. **pulls.merge-unknown** — `PUT .../pulls/999999999/merge` → **404** `{message}`.
16. **pulls.merge-conflict** — dua branch dari commit yang sama, keduanya mengubah FILE YANG SAMA
    dgn konten berbeda (`fileContentAlt (a)` vs `(b)`, update=true → PUT dgn sha); dua PR.
    Merge pertama → 200; merge kedua (konflik) → **405** `{message}`.
17. **pulls.list-state-all** — `GET .../pulls?state=all&per_page=100` memuat PR merged DAN PR
    open kedua.
18. **pulls.list-default-open** — `GET .../pulls?per_page=100` (tanpa state) TIDAK memuat PR
    merged, memuat PR open.
19. **pulls.list-shape** — `?state=all&per_page=10` → array tak kosong, tiap item pullShape.
20. **pulls.get-unknown** — `GET .../pulls/999999999` → **404** `{message}`.

## B.5 protocol (5, bagian REST)

1. **protocol.content-type-json** — 6 panggilan (GET /, GET /meta, GET repo, GET issues, GET
   unknown route, GET repo tanpa token): semua punya content-type JSON (regex `isJsonContentType`)
   dan bukan HTML (`expectNoHtml`).
2. **protocol.unknown-route-json-404** — `GET /api/v3/no-such-route/<repoPrefix>` → 404
   `{message}` + bukan HTML.
3. **protocol.malformed-body-400** — `POST /api/v3/user/repos` dengan rawBody `'{"name":'
   (content-type application/json)` → **400** `{message}`.
4. **protocol.request-id** — 4 panggilan (GET /, GET repo, GET unknown, GET tanpa token): tiap
   respons punya header `x-github-request-id` NON-EMPTY.
5. **protocol.error-message** — 404 missing repo, 401 tanpa token, 422 bad label: semuanya
   `{message: nonEmpty string}`.

## B.6 Edge-case ringkas yang paling sering keliru

- **404 vs 403**: nama repo yang sama di bawah owner lain → 404 (jangan 403). Tanpa token → 401.
- Status persis, bukan range: 201 create (kecuali contents-update & pagination-422), 204 delete
  repo, 200 untuk contents update/close/merge/delete-file, 400 malformed, 409 stale sha,
  422 bad label, 405 merge conflict, 404 unknown.
- `default_branch` harus stabil antar GET.
- Issue numbers increment tepat +1 per repo.
- Halaman pagination ≤10 item dengan per_page=10, ≥3 halaman untuk 30 repo, Link rel=next
  same-origin, tidak ada duplikat antar halaman.
- Semua respons (termasuk 404/401/400/422) JSON `{message}` — tidak boleh HTML.
- `X-GitHub-Request-Id` non-empty di semua respons; `X-OAuth-Scopes` wajib di GET /api/v3/;
  X-RateLimit-* TIDAK diwajibkan.
- Merge selalu `merge_method: 'squash'`; merge commit harus benar-benar berada di default branch
  (commits list + konten file), dan `merge_commit_sha` di pull == sha merge.

# WinSCP Web — Resumable Transfers

> subagent-driven-development with spec + code-quality review per milestone.

**Goal:** Large transfers survive interruption — on retry after a dropped connection, resume from where the destination left off instead of restarting. Requested by the user for large downloads.

## Design (the seam)
Extend `src/fs/FileSystem.ts` minimally so resume is a filesystem capability the engine drives uniformly:
- `openRead(path: string, offset?: number): Promise<ReadHandle>` — begin reading at `offset` (default 0).
- `openWrite(path: string, size?: number, opts?: { resume?: boolean }): Promise<WriteHandle>` — `resume:true` continues an interrupted write instead of truncating.
- `WriteHandle` gains `readonly startOffset: number` — the byte offset this write resumes from (0 for a fresh write). The engine reads the source from `startOffset`.

The engine never needs to know HOW each backend resumes; it asks `openWrite({resume})`, reads `startOffset`, and streams the source from there.

### Engine (`src/transfer/engine.ts`)
`transferFile(src, srcPath, dst, dstPath, size, opts & { resume?: boolean })`:
1. `const w = await dst.openWrite(dstPath, size, { resume: opts.resume });`
2. `const start = w.startOffset;` — if `size !== undefined && start >= size` → already complete: `await w.close(); onProgress({bytes:size,total:size}); return;`
3. `const r = await src.openRead(srcPath, start);`
4. `let bytes = start; onProgress({bytes, total:size});` then the existing chunk loop (read→write→progress), abort/close semantics unchanged.

### Queue (`src/transfer/queue.ts`)
Jobs are resumable by default. On `retry(id)`, keep the job's paths and pass `resume:true` to `transferFile`, so a retried job continues from the destination's current state. Progress bar reflects resumed bytes (starts partway).

### Backends
- **MockFS**: openRead(offset) serves from offset; openWrite({resume}) → startOffset = existing file's byte length (0 if none), append (don't clear). Fully testable.
- **SftpFS**: openRead(path, offset) → SFTP OPEN(READ), initial read offset = offset. openWrite(path,size,{resume}) → if resume: `stat` the file, `startOffset = size ?? 0`, OPEN WRITE|CREAT (NO TRUNC), write from startOffset; else OPEN WRITE|CREAT|TRUNC, startOffset 0. **Fully live-verifiable** (uploads OneDrive→SFTP resume against the real server).
- **OneDriveFS**: openRead(path, offset) → range GET from offset. openWrite({resume}) → a module-level Map<path,{uploadUrl}> retains in-flight resumable upload sessions; on resume with a retained session, `GET uploadUrl` → parse `nextExpectedRanges` → startOffset = next expected start, continue PUTting; else fresh session (retain it), startOffset 0. Remove from the map on successful close. This gives within-session resume for downloads (SFTP→OneDrive). (Note: a OneDrive partial upload is not a stat-able file, so resume relies on the retained session — it survives a retry, not a full app reload; SFTP-dest resume survives reload since the server keeps the partial file.)

## Milestones
- **M1** — interface + MockFS + engine resume + tests: openRead(offset) serves from offset; openWrite({resume}) reports startOffset = existing size and appends; engine resumes from startOffset (interrupt a MockFS transfer at N bytes, retry with resume → the dest ends byte-exact, and the source was read only from N onward). Also: retry path in the queue passes resume.
- **M2** — SftpFS resume + tests + LIVE: SFTP openRead(offset), openWrite({resume}) via stat+offset. Extend the transfer harness to upload a file to the server, "interrupt" (close mid-way), then resume with `{resume:true}` and byte-compare — live against 192.168.200.51.
- **M3** — OneDriveFS resume (openRead offset via range GET; openWrite session-resume via retained upload session + nextExpectedRanges) + tests (mocked graph).
- **M4** — queue/UI: mark jobs resumable; the transfer row shows "resuming from NN%"; Retry on a partially-done job resumes. Build.

## Guardrails
- `startOffset` never exceeds the source size (cap/validate); a stale/oversized partial → restart (truncate) rather than corrupt.
- Resume is opt-in per transfer (default on for retries); a fresh transfer truncates (no accidental append onto an unrelated file).
- Streaming preserved; no whole-file buffering.

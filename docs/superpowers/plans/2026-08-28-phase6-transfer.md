# WinSCP Web — Plan 6: Transfer Engine

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development with spec + code-quality review. Checkbox steps.

**Goal:** Move files between the two panes' `FileSystem`s (OneDrive ⇄ SFTP) — a streaming transfer engine + a job queue with progress, cancel, conflict resolution, and retry, plus the UI to drive it (toolbar Upload/Download, keyboard, drag-and-drop, a live transfer-queue panel). This is the core WinSCP function.

**Depends on:** the `FileSystem` seam (`openRead`/`openWrite`/`stat`/`mkdir`/`list`, `ReadHandle`/`WriteHandle` with `abort`, `FsError`), `OneDriveFS`, `SftpFS`, the panes/layouts, `AppProvider`. No changes to the FS implementations.

## Design

### Engine (`src/transfer/engine.ts`)
Pure streaming between any two `FileSystem`s — no UI, no queue.
- `interface TransferProgress { bytes: number; total?: number }`
- `interface TransferOptions { signal?: AbortSignal; onProgress?: (p: TransferProgress) => void; chunkSize?: number }` (default chunk 256 KiB).
- `async transferFile(src, srcPath, dst, dstPath, size: number|undefined, opts?): Promise<void>` — `r = src.openRead(srcPath)`, `w = dst.openWrite(dstPath, size)`; loop: if `signal?.aborted` → throw `TransferCancelled`; `n = await r.read(buf)`; if `n===0` break; `await w.write(buf.subarray(0,n))`; `bytes+=n; onProgress({bytes, total:size})`. On success: `await w.close(); await r.close()`. On ANY error/abort: `await w.abort().catch(()=>{}); await r.close().catch(()=>{})`, rethrow. `TransferCancelled extends Error`.
- `async transferTree(src, srcPath, dst, dstPath, opts?, onFile?): Promise<void>` — `stat` src; if dir: `dst.mkdir(dstPath)` (swallow FsError 'exists'); `for (const child of await src.list(srcPath)) transferTree(child.path, joinPath(dstPath, child.name), ...)`. If file: `transferFile(..., child.size, ...)`. `onFile` callback per file for progress aggregation. Respects `signal`.

### Queue (`src/transfer/queue.ts`)
- `type JobState = 'queued' | 'active' | 'conflict' | 'done' | 'skipped' | 'error' | 'cancelled'`.
- `interface TransferJob { id; name; direction: 'up' | 'down'; src: FileSystem; srcPath: string; dst: FileSystem; dstPath: string; size?: number; isDir: boolean; state: JobState; bytes: number; error?: string }`.
- `type ConflictChoice = 'overwrite' | 'skip' | 'rename'`. `type ConflictResolver = (job: TransferJob) => Promise<ConflictChoice>`.
- `class TransferQueue`: constructor `(opts?: { concurrency?: number; conflict?: ConflictResolver })` (default concurrency 2, default resolver → 'overwrite'). 
  - `enqueue(entry): string` (adds a job, returns id, kicks the pump).
  - Pump: while active < concurrency and queued jobs exist, start the next. For a file job: if `dst` already has the target (`stat` succeeds) → set state 'conflict', call the resolver → 'overwrite' (proceed, unlinking not needed — openWrite truncates), 'skip' (state 'skipped'), 'rename' (append ` (n)` before the extension until free). Then run `transferFile` with an AbortController; update `bytes`/progress via a throttled emit; on done → 'done'; on `TransferCancelled` → 'cancelled'; on error → 'error' with message. Dir jobs use `transferTree` (conflict handling per-file inside; simplest: dir jobs overwrite/merge).
  - `cancel(id)`: abort that job's controller; if still queued → 'cancelled'. `cancelAll()`.
  - `retry(id)`: re-queue a failed job.
  - `subscribe(listener: (jobs: TransferJob[]) => void): () => void` — emits the job list on any change (throttled for progress, immediate for state changes). `jobs(): TransferJob[]`. `clearFinished()`.
- Rename helper `uniqueName(dst, dir, name): Promise<string>` — probe `dst.stat(joinPath(dir, candidate))`; on 'not-found' it's free.

### UI
- `src/ui/TransferQueue.tsx` (replace the placeholder): render the real jobs — per row: direction arrow, name, a progress bar (`bytes/total`), state (queued/active %/done/skipped/error/cancelled), a cancel (or retry on error) button. A header with overall count + a "Clear finished" + "Cancel all". Empty → "No transfers."
- `src/ui/ConflictDialog.tsx` — a Modal shown when a job needs a decision: "`name` already exists in the destination." Buttons Overwrite / Skip / Rename, and an "Apply to all" checkbox (the resolver remembers the choice for the rest of this batch).
- **Transfer actions** in the panes:
  - PaneView: support multi-select (Shift/Ctrl click), expose the current selection + cwd upward via callbacks (or the pane reports selection to the provider). Add `onTransfer(entries)` — invoked by the toolbar Upload/Download, Enter-less F5, or drag-drop.
  - Toolbar Upload/Download (Commander): Upload = local-pane selection → remote cwd; Download = remote selection → local cwd. Wire to `AppProvider.enqueueTransfer(...)`.
  - **Drag-and-drop:** dragging selected rows from one pane and dropping on the other pane enqueues transfers to that pane's cwd. Use HTML5 DnD (draggable rows, onDragStart sets a payload of the dragged paths + source side; pane onDrop reads it and enqueues). Keep it simple and robust.
  - **Keyboard:** F5 = transfer selection to the other pane (WinSCP copy). Del already exists conceptually; wire F5 here.

### AppProvider wiring
- A memoized `TransferQueue` with a conflict resolver bound to a `conflictPrompt` state (like the host-key prompt pattern: resolver returns a Promise resolved by the ConflictDialog). Expose `jobs` (reactive via subscribe), `enqueueTransfer({ from: 'local'|'remote', entries: FsEntry[], toDir: string })` that resolves src/dst FileSystems + builds jobs, `cancelJob`, `cancelAllJobs`, `retryJob`, `clearFinished`, and the `conflictPrompt` + `resolveConflict(choice, applyToAll)`.
- Panes report their current cwd + selection to the provider (so Upload/Download/F5 know source/target dirs). Simplest: the provider holds `localCwd`/`remoteCwd` + `localSelection`/`remoteSelection`, updated by PaneView via callbacks; the toolbar/keyboard actions read them.

## Milestones
- **M1 — engine.** `engine.ts` (+test with two `MockFS`): transferFile copies bytes exactly (compare after); onProgress reports increasing bytes ending at total; abort mid-transfer via AbortSignal → `TransferCancelled` and dst.openWrite.abort called (use a MockFS/instrumented handle); transferTree recreates a nested dir with files. Deterministic, no network.
- **M2 — queue.** `queue.ts` (+test): enqueue a job → runs → 'done', jobs bytes reach size; concurrency cap respected (enqueue 3 with concurrency 2 → at most 2 active); conflict on existing dest → resolver 'skip' → 'skipped', 'rename' → new name used (assert dst got ` (1)`), 'overwrite' → replaced; cancel a queued and an active job; retry a failed job; subscribe emits on changes. Use two MockFS instances (pre-seed the dest to force a conflict).
- **M3 — UI + AppProvider wiring + build + LIVE.** Real TransferQueue panel, ConflictDialog, PaneView multi-select + selection/cwd reporting + DnD + F5, toolbar Upload/Download, AppProvider transfer state. Render tests (queue panel shows a job's progress + cancel; ConflictDialog buttons call resolveConflict). `npm run build` static; suite green; typecheck clean. **LIVE:** extend `scripts/sftp-verify.mts` (or a new `scripts/transfer-verify.mts`) to use the ENGINE to upload a file from an in-memory `MockFS` to the real `SftpFS`, then download it back to another MockFS, and byte-compare — proving the engine streams correctly against the real server. Run it live; paste the transcript.

## Guardrails
- Streaming only — never buffer a whole file (chunked read→write). Large files must not blow memory.
- Cancel must `abort()` the dest write (so partial files are cleaned up where the FS supports it) and stop promptly.
- Conflict 'rename' must actually find a free name (probe until 'not-found').
- Progress emits throttled (~10/s) so the UI doesn't thrash; state changes emit immediately.
- A failed job doesn't abort the whole queue; other jobs proceed.
- No secrets/paths logged beyond what the UI shows.

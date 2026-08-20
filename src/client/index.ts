/**
 * dsh-file-link client half.
 *
 * Makes `file:line`, `file:line:col` and `file#L123` references in chat
 * replies clickable: a click opens the file in the dsh-better-sidebar editor
 * and jumps to the requested line. Bare file paths (absolute, or containing a
 * path separator) are also clickable and open without a jump.
 *
 * `dsh-better-sidebar` is an OPTIONAL peer: when present the file opens in its
 * editor and jumps to the line; when absent we fall back to the host's system
 * open (`workspaces.openPath`), matching the default DSH behavior.
 *
 * The jump reuses the editor's own CodeMirror view through the public
 * `EditorView.findFromDOM` trick — CodeMirror writes a plain `cmTile` property
 * on its content DOM, so we can reach `view.state.doc` and `view.dispatch`
 * without importing any CodeMirror package or forking the editor.
 */

export const inject = ['sessions', 'workspaces']

// ── Service shapes (kept loose: the host provides the real implementations) ─

interface SessionSummary {
  cwd?: string
}

interface SessionsService {
  list: {
    getSnapshot(): { current?: string; byId: Record<string, SessionSummary> }
  }
}

interface WorkspacesService {
  openPath(path: string): Promise<void>
}

interface OpenTabSeed {
  type: string
  title?: string
  path?: string
  id?: string
  meta?: unknown
}

interface BetterSidebarService {
  openTab(seed: OpenTabSeed, scope?: { sessionId: string; cwd?: string }): void
}

interface Ctx {
  sessions: SessionsService
  workspaces: WorkspacesService
  get(name: string): unknown
  effect(callback: () => (() => void) | void, label?: string): void
}

// ── file:line parsing ───────────────────────────────────────────────────────

interface FileRef {
  path: string
  line?: number
  column?: number
}

/** Whether a string plausibly names a file (not an arbitrary code token). */
function looksLikePath(text: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(text)) return true // Windows drive (D:\...)
  if (text.startsWith('/') || text.startsWith('\\')) return true // POSIX / UNC absolute
  if (/[\\/]/.test(text)) return true // contains a path separator
  return false
}

/**
 * Parse a file reference out of an inline-code token's text.
 * Supported shapes: `path`, `path:line`, `path:line:col`, `path#Lline`.
 * The path part must look like a real path so ordinary prose (`12:30`) is
 * never treated as a jump target.
 */
function parseFileRef(raw: string): FileRef | null {
  const text = raw.trim()
  if (text === '' || text.length > 512) return null

  // GitHub-style `path#L123` (also tolerate `path#L123-L456`).
  const hash = /^(.*?)#L(\d+)(?:-L?\d+)?$/.exec(text)
  if (hash !== null && looksLikePath(hash[1]!)) {
    return { path: hash[1]!, line: Number(hash[2]) }
  }

  // `path:line:column`
  const col = /^(.*):(\d+):(\d+)$/.exec(text)
  if (col !== null && looksLikePath(col[1]!)) {
    return { path: col[1]!, line: Number(col[2]), column: Number(col[3]) }
  }

  // `path:line` (the trailing `:digits` is the line, not a drive letter)
  const line = /^(.*):(\d+)$/.exec(text)
  if (line !== null && looksLikePath(line[1]!)) {
    return { path: line[1]!, line: Number(line[2]) }
  }

  // Bare path (no line)
  if (looksLikePath(text)) return { path: text }
  return null
}

// ── Path resolution ─────────────────────────────────────────────────────────

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

/** Resolve a relative path against the session cwd (Windows and POSIX aware). */
function resolvePath(cwd: string | undefined, path: string): string {
  const cleaned = path.trim()
  if (isAbsolutePath(cleaned)) return cleaned
  const base = (cwd ?? '').replace(/[\\/]+$/, '')
  if (base === '') return cleaned
  const sep = base.includes('\\') ? '\\' : '/'
  return base + sep + cleaned.replace(/[\\/]+/g, sep)
}

function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

// ── CodeMirror jump (via the public `.cmTile` DOM handle) ───────────────────

/** A CodeMirror 6 EditorView, minimally typed (the real instance is the
 *  sidebar editor's own, shared through the DOM `cmTile` property). */
interface EditorViewLike {
  state: { doc: { length: number; lines: number; line(n: number): { from: number; to: number } } }
  dispatch(spec: { selection: { anchor: number }; scrollIntoView: boolean }): void
}

/** Walk up from a `.cm-content` element reading CodeMirror's `cmTile` handle. */
function editorViewOf(el: HTMLElement): EditorViewLike | null {
  let node: HTMLElement | null = el
  while (node !== null) {
    const tile = (node as unknown as { cmTile?: { root?: { view?: EditorViewLike } } }).cmTile
    if (tile !== undefined && tile.root?.view !== undefined) return tile.root.view
    node = node.parentElement
  }
  return null
}

/** Whether an element is currently laid out (the active tab's editor). */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent !== null) return true
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

let pendingLine: number | null = null
let pendingColumn: number | null = null

/** Try once to find the active editor and jump; true when settled. */
function tryJumpNow(): boolean {
  if (pendingLine === null) return false
  const line = pendingLine
  const column = pendingColumn
  const editors = document.querySelectorAll('.cm-content')
  for (const raw of Array.from(editors)) {
    const el = raw as HTMLElement
    if (!isVisible(el)) continue
    const view = editorViewOf(el)
    if (view === null) continue
    const doc = view.state.doc
    if (doc.length === 0) continue
    // Out-of-range line: settle silently (nothing meaningful to scroll to).
    if (line < 1 || line > doc.lines) {
      pendingLine = null
      pendingColumn = null
      return true
    }
    const lineInfo = doc.line(line)
    const columnClamped = column === null ? 0 : Math.max(0, Math.min(column - 1, lineInfo.to - lineInfo.from))
    const anchor = lineInfo.from + columnClamped
    try {
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
    } catch {
      // The dispatch surface may drift across versions; a failed jump must
      // never break the click — the file is already open at that point.
    }
    pendingLine = null
    pendingColumn = null
    return true
  }
  return false
}

/** Poll until the async editor mount lets us jump (or a deadline passes). */
function scheduleJump(line: number, column?: number): void {
  pendingLine = line
  pendingColumn = column ?? null
  const deadline = Date.now() + 5000
  const tick = (): void => {
    if (pendingLine === null) return
    if (Date.now() > deadline) {
      pendingLine = null
      pendingColumn = null
      return
    }
    if (tryJumpNow()) return
    window.setTimeout(tick, 100)
  }
  // Small delay so the sidebar can switch to the target tab before we scan.
  window.setTimeout(tick, 150)
}

// ── Open a parsed reference ─────────────────────────────────────────────────

function openRef(ctx: Ctx, ref: FileRef): void {
  const snapshot = ctx.sessions.list.getSnapshot()
  const sessionId = snapshot.current
  const cwd = sessionId !== undefined ? snapshot.byId[sessionId]?.cwd : undefined
  const absolute = resolvePath(cwd, ref.path)

  const betterSidebar = ctx.get('betterSidebar') as BetterSidebarService | undefined
  if (betterSidebar === undefined) {
    // No sidebar plugin: fall back to the host's default system open.
    void ctx.workspaces.openPath(absolute)
    return
  }

  betterSidebar.openTab(
    {
      type: 'editor',
      title: basename(absolute),
      path: absolute,
      id: `editor:${absolute}`,
      meta: ref.line !== undefined ? { line: ref.line, column: ref.column } : undefined,
    },
    sessionId !== undefined ? { sessionId, cwd } : undefined,
  )

  if (ref.line !== undefined) scheduleJump(ref.line, ref.column)
}

// ── Click delegation ────────────────────────────────────────────────────────

function registerClickDelegation(ctx: Ctx): () => void {
  const onClick = (event: MouseEvent): void => {
    // Plain left-click only; modifiers always bypass (let the browser win).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (event.defaultPrevented) return
    const target = event.target
    if (!(target instanceof Element)) return

    const code = target.closest('code')
    if (code === null) return
    // Never intercept code that is already a link (official file mentions)
    // or that lives inside a code block.
    if (code.closest('a') !== null || code.closest('pre') !== null) return

    const ref = parseFileRef(code.textContent ?? '')
    if (ref === null) return

    event.preventDefault()
    event.stopPropagation()
    openRef(ctx, ref)
  }

  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

// ── Plugin body ─────────────────────────────────────────────────────────────

export function apply(ctx: Ctx): void {
  ctx.effect(() => registerClickDelegation(ctx), 'dsh-file-link: click delegation')
}

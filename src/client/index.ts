/**
 * dsh-file-link client half.
 *
 * Makes `file:line`, `file:line:col` and `file#L123` references in chat
 * replies clickable: a click opens the file in the dsh-better-sidebar editor
 * and jumps to the requested line. Bare file paths (absolute, or containing a
 * path separator) are also clickable and open without a jump.
 *
 * Behavior notes:
 * - Styling: a MutationObserver decorates matching inline <code> elements
 *   with a link look (business blue + pointer + hover underline) and a
 *   tooltip, so references are discoverable; re-applied after re-renders.
 * - Landing: better-sidebar's openTab lands in the ACTIVE pane — when that
 *   pane lives in the bottom panel we first activate a right-panel tab so the
 *   file always lands in the right sidebar.
 * - Jump: the target line is selected as a RANGE (whole line highlighted)
 *   and scrolled into view, so the landing line is unmistakable. The editor
 *   is located through the editor host's path input (`input[title=path]`)
 *   when possible, falling back to the first visible CodeMirror instance.
 *
 * `dsh-better-sidebar` is an OPTIONAL peer: when present the file opens in its
 * editor and jumps; when absent we fall back to the host's system open.
 * CodeMirror is reached through the public `cmTile` DOM handle — no
 * CodeMirror dependency, no editor fork.
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

interface TabLike {
  id: string
  path?: string
}

interface SplitNodeLike {
  kind: 'leaf' | 'split'
  id: string
  tabs?: TabLike[]
  active?: string | null
  children?: SplitNodeLike[]
}

interface SidebarStateLike {
  activePane: string | null
  splits: SplitNodeLike
  bottomSplits: SplitNodeLike
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
  activateTab(tabId: string, scope?: { sessionId: string }): void
  getSnapshot(): { sessionId?: string; state?: SidebarStateLike }
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

// ── Sidebar state walking ───────────────────────────────────────────────────

function allLeavesOf(node: SplitNodeLike): SplitNodeLike[] {
  if (node.kind === 'leaf') return [node]
  return (node.children ?? []).flatMap(allLeavesOf)
}

function treeHasId(node: SplitNodeLike, id: string): boolean {
  if (node.id === id) return true
  if (node.kind === 'split') return (node.children ?? []).some(child => treeHasId(child, id))
  return false
}

/** Whether the target file's tab is the active tab of its pane (i.e. displayed). */
function targetTabActive(bs: BetterSidebarService, absolute: string): boolean {
  const state = bs.getSnapshot().state
  if (state === undefined) return false
  for (const leaf of [...allLeavesOf(state.splits), ...allLeavesOf(state.bottomSplits)]) {
    const tab = (leaf.tabs ?? []).find(candidate => candidate.path === absolute)
    if (tab !== undefined) return leaf.active === tab.id
  }
  return false
}

/**
 * The right sidebar must own the landing: better-sidebar's openTab lands in
 * the ACTIVE pane, so when that pane lives in the bottom panel we activate a
 * right-panel tab first, moving the active pane into the right tree.
 */
function forceRightPanelLanding(bs: BetterSidebarService): void {
  const state = bs.getSnapshot().state
  if (state === undefined || state.activePane === null) return
  if (!treeHasId(state.bottomSplits, state.activePane)) return
  for (const leaf of allLeavesOf(state.splits)) {
    const tabs = leaf.tabs ?? []
    if (tabs.length === 0) continue
    const tabId = leaf.active ?? tabs[0]!.id
    bs.activateTab(tabId)
    return
  }
}

// ── CodeMirror jump (via the public `.cmTile` DOM handle) ───────────────────

interface EditorViewLike {
  state: { doc: { length: number; lines: number; line(n: number): { from: number; to: number } } }
  dispatch(spec: { selection: { anchor: number; head?: number }; scrollIntoView: boolean }): void
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

/** Whether an element is currently laid out (displayed, not display:none). */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent !== null) return true
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function cssEscape(value: string): string {
  const globalCss = (window as unknown as { CSS?: { escape?: (v: string) => string } }).CSS
  if (globalCss?.escape !== undefined) return globalCss.escape(value)
  return value.replace(/["\\]/g, '\\$&')
}

/**
 * Locate the CodeMirror content element for one absolute path: the editor
 * host's path input carries `title={path}`, so find it and take the nearest
 * ancestor that contains a `.cm-content`. Returns null when not mounted yet.
 */
function editorContentForPath(absolute: string): HTMLElement | null {
  let input: HTMLElement | null = null
  try {
    input = document.querySelector(`input[title="${cssEscape(absolute)}"]`)
  } catch {
    return null
  }
  if (input === null) return null
  let node: HTMLElement | null = input
  for (let depth = 0; depth < 8 && node !== null; depth += 1) {
    const cm = node.querySelector('.cm-content')
    if (cm !== null) return cm as HTMLElement
    node = node.parentElement
  }
  return null
}

interface PendingJump {
  bs: BetterSidebarService
  absolute: string
  line: number
}

let pending: PendingJump | null = null

/** Try once to find the target editor and jump; true when settled. */
function tryJumpNow(): boolean {
  if (pending === null) return false
  const { bs, absolute, line } = pending

  // Wait until the target file's tab is the displayed tab of its pane, so we
  // never jump a stale editor from before the tab switch.
  if (!targetTabActive(bs, absolute)) return false

  // Prefer the editor that belongs to this exact path; fall back to the first
  // visible one (single-pane layouts — the common case).
  const byPath = editorContentForPath(absolute)
  const candidates: HTMLElement[] = []
  if (byPath !== null) candidates.push(byPath)
  for (const raw of Array.from(document.querySelectorAll('.cm-content'))) {
    const el = raw as HTMLElement
    if (el !== byPath) candidates.push(el)
  }

  for (const el of candidates) {
    if (!isVisible(el)) continue
    const view = editorViewOf(el)
    if (view === null) continue
    const doc = view.state.doc
    if (doc.length === 0) continue
    if (line < 1 || line > doc.lines) {
      pending = null // out of range: settle silently
      return true
    }
    const lineInfo = doc.line(line)
    // Select the WHOLE line so the landing is unmistakable; an empty line
    // selects its newline so it still shows a highlight.
    const head = lineInfo.to > lineInfo.from
      ? lineInfo.to
      : Math.min(lineInfo.from + 1, doc.length)
    try {
      view.dispatch({ selection: { anchor: lineInfo.from, head }, scrollIntoView: true })
    } catch {
      // A dispatch surface drift must never break the click — the file is
      // already open at that point.
    }
    pending = null
    return true
  }
  return false
}

/** Poll until the async editor mount lets us jump (or a deadline passes). */
function scheduleJump(bs: BetterSidebarService, absolute: string, line: number): void {
  pending = { bs, absolute, line }
  const deadline = Date.now() + 5000
  const tick = (): void => {
    if (pending === null) return
    if (Date.now() > deadline) {
      pending = null
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

  const bs = ctx.get('betterSidebar') as BetterSidebarService | undefined
  if (bs === undefined) {
    // No sidebar plugin: fall back to the host's default system open.
    void ctx.workspaces.openPath(absolute)
    return
  }

  forceRightPanelLanding(bs)

  bs.openTab(
    {
      type: 'editor',
      title: basename(absolute),
      path: absolute,
      id: `editor:${absolute}`,
      meta: ref.line !== undefined ? { line: ref.line, column: ref.column } : undefined,
    },
    sessionId !== undefined ? { sessionId, cwd } : undefined,
  )

  if (ref.line !== undefined) scheduleJump(bs, absolute, ref.line)
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

// ── Link styling for matching inline <code> elements ────────────────────────

const LINK_CLASS = 'dsh-file-link'

function injectStyles(): HTMLStyleElement {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-file-link'
  tag.textContent = [
    `code.${LINK_CLASS}{color:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#3b82f6));cursor:pointer;}`,
    `code.${LINK_CLASS}:hover{text-decoration:underline;}`,
  ].join('\n')
  document.head.appendChild(tag)
  return tag
}

function tooltipFor(ref: FileRef): string {
  return ref.line !== undefined
    ? `打开并跳到第 ${ref.line} 行 · open at line ${ref.line}`
    : '打开文件 · open file'
}

/** Decorate one <code> element when its text parses as a file reference. */
function decorate(el: HTMLElement): void {
  if (el.classList.contains(LINK_CLASS)) return // already decorated
  const ref = parseFileRef(el.textContent ?? '')
  if (ref === null) return
  el.classList.add(LINK_CLASS)
  el.setAttribute('title', tooltipFor(ref))
}

/** Scan the whole document once (cheap: parse only undecorated code elements). */
function scanAll(): void {
  for (const raw of Array.from(document.querySelectorAll('code'))) {
    decorate(raw as HTMLElement)
  }
}

/**
 * Keep the decoration alive across React re-renders: a debounced
 * MutationObserver re-scans after DOM churn (React may reset className on
 * the elements it owns; the observer re-applies the class + title).
 */
function registerStyling(): () => void {
  if (document.body === null) return () => { /* no-op */ }
  const tag = injectStyles()
  let timer: number | null = null
  const schedule = (): void => {
    if (timer !== null) return
    timer = window.setTimeout(() => {
      timer = null
      scanAll()
    }, 150)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  scanAll()
  return () => {
    observer.disconnect()
    if (timer !== null) window.clearTimeout(timer)
    tag.remove()
  }
}

// ── Plugin body ─────────────────────────────────────────────────────────────

export function apply(ctx: Ctx): void {
  ctx.effect(() => registerClickDelegation(ctx), 'dsh-file-link: click delegation')
  ctx.effect(() => registerStyling(), 'dsh-file-link: link styling')
}

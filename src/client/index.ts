/**
 * dsh-file-link client half.
 *
 * Makes `file:line`, `file:line:col`, `file:start-end` and `file#L123`
 * references in chat
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
  endLine?: number
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

  // GitHub-style `path#L123` (also `path#L123-L456` ranges).
  const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(text)
  if (hash !== null && looksLikePath(hash[1]!)) {
    return {
      path: hash[1]!,
      line: Number(hash[2]),
      endLine: hash[3] !== undefined ? Number(hash[3]) : undefined,
    }
  }

  // `path:line:column`
  const col = /^(.*):(\d+):(\d+)$/.exec(text)
  if (col !== null && looksLikePath(col[1]!)) {
    return { path: col[1]!, line: Number(col[2]), column: Number(col[3]) }
  }

  // `path:startLine-endLine` (a line range; reversed bounds are normalized)
  const range = /^(.*):(\d+)-(\d+)$/.exec(text)
  if (range !== null && looksLikePath(range[1]!)) {
    const a = Number(range[2])
    const b = Number(range[3])
    return { path: range[1]!, line: Math.min(a, b), endLine: Math.max(a, b) }
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
  state: {
    doc: {
      length: number
      lines: number
      line(n: number): { from: number; to: number }
      lineAt(pos: number): { from: number; to: number; number: number }
    }
  }
  dispatch(spec: { selection: { anchor: number; head?: number }; scrollIntoView?: boolean; effects?: unknown }): void
  domAtPos(pos: number): { node: Node; offset: number }
  posAtCoords(coords: { x: number; y: number }): number | null
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
  endLine?: number
}

let pending: PendingJump | null = null

/** Try once to find the target editor and jump; true when settled. */
function tryJumpNow(): boolean {
  if (pending === null) return false
  const { bs, absolute, line, endLine } = pending

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
    // Clamp the range into the document (friendlier than bailing on a
    // partially out-of-range request like :74-1000).
    const startLine = Math.max(1, Math.min(line, doc.lines))
    const lastLine = endLine === undefined
      ? startLine
      : Math.max(startLine, Math.min(endLine, doc.lines))
    const start = doc.line(startLine)
    const end = doc.line(lastLine)
    const head = end.to > start.from ? end.to : Math.min(start.from + 1, doc.length)
    // Scroll strategy: prefer CodeMirror's OFFICIAL centered scroll effect
    // (`EditorView.scrollIntoView(pos, { y: 'center' })`, reached through the
    // view's own class) — CodeMirror computes the centered target itself, so
    // there is no animation-frame race against its own scroll settling. Fall
    // back to minimal scroll + manual next-frame re-centering when the static
    // is not reachable.
    let centerEffect: unknown
    try {
      const ctor = view.constructor as unknown as {
        scrollIntoView?: (pos: number, options: { y: 'center' }) => unknown
      }
      centerEffect = ctor.scrollIntoView?.(start.from, { y: 'center' })
    } catch {
      centerEffect = undefined
    }
    let usedEffect = false
    try {
      if (centerEffect !== undefined) {
        view.dispatch({ selection: { anchor: start.from, head }, effects: centerEffect })
        usedEffect = true
      } else {
        view.dispatch({ selection: { anchor: start.from }, scrollIntoView: true })
        view.dispatch({ selection: { anchor: start.from, head } })
      }
    } catch {
      // A dispatch surface drift must never break the click — the file is
      // already open at that point.
    }
    // The visible landing marker: a self-drawn per-line highlight over the
    // range. The editor's own selection is near-invisible while unfocused
    // (and whether it renders at all depends on the editor's drawSelection
    // setup), so the overlay — independent of focus — marks the lines.
    const lineEl = highlightTargetLines(view, startLine, lastLine)
    if (lineEl !== null) {
      // Self-correcting centering. The centered scroll effect targets the
      // viewport center, but late layout shifts (font load, gutter mount,
      // CodeMirror's own "keep the selection visible" pass a frame or two
      // later) can still leave the line a few lines off-center. These
      // verification passes re-measure from live rects shortly after the
      // jump and re-center only when the line is STILL VISIBLE yet clearly
      // off-center — idempotent, and never fighting the user once they
      // scrolled the line away.
      const verify = (): void => centerLineElement(lineEl, 10)
      window.requestAnimationFrame(() => { window.requestAnimationFrame(verify) })
      window.setTimeout(verify, 220)
    }
    pending = null
    return true
  }
  return false
}

/** Poll until the async editor mount lets us jump (or a deadline passes). */
function scheduleJump(bs: BetterSidebarService, absolute: string, line: number, endLine?: number): void {
  pending = { bs, absolute, line, endLine }
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

// ── Visible line highlight (self-drawn overlay on the `.cm-line` element) ───

const LINE_CLASS = 'dsh-file-link-line'

interface ActiveRange {
  scroller: HTMLElement
  view: EditorViewLike
  start: number
  end: number
  onScroll: () => void
}

let activeRange: ActiveRange | null = null
let paintQueued = false

/** Drop the current range highlight (called when a new jump lands). */
function clearLineHighlight(): void {
  if (activeRange !== null) {
    activeRange.scroller.removeEventListener('scroll', activeRange.onScroll)
    activeRange = null
  }
  // Sweep any straggler classes (also covers detached nodes from old panes).
  for (const el of Array.from(document.querySelectorAll(`.${LINE_CLASS}`))) {
    el.classList.remove(LINE_CLASS)
  }
}

/** Re-paint the overlay on the RENDERED lines inside the active range. */
function paintRangeLines(): void {
  paintQueued = false
  const ar = activeRange
  if (ar === null) return
  const doc = ar.view.state.doc
  for (const raw of Array.from(ar.scroller.querySelectorAll('.cm-line'))) {
    const el = raw as HTMLElement
    const rect = el.getBoundingClientRect()
    let pos: number | null = null
    try {
      pos = ar.view.posAtCoords({ x: rect.left + 1, y: rect.top + rect.height / 2 })
    } catch {
      pos = null
    }
    if (pos === null) continue
    let num = 0
    try {
      num = doc.lineAt(pos).number
    } catch {
      continue
    }
    if (num >= ar.start && num <= ar.end) el.classList.add(LINE_CLASS)
  }
}

/**
 * Paint the overlay over a line range [startLine, endLine]. CodeMirror
 * virtualizes lines (only the rendered window exists in the DOM), so the
 * overlay is painted per rendered line and refreshed on scroller scroll —
 * lines entering the viewport pick up the class as they render. The overlay
 * PERSISTS until the next jump lands (IDE-selection semantics).
 * @returns the START line's `.cm-line` element, or null when not found.
 */
function highlightTargetLines(view: EditorViewLike, startLine: number, endLine: number): HTMLElement | null {
  let node: HTMLElement | null = null
  try {
    const from = view.state.doc.line(startLine).from
    const loc = view.domAtPos(from)
    node = loc.node instanceof HTMLElement ? loc.node : loc.node.parentElement
    for (let depth = 0; depth < 6 && node !== null; depth += 1) {
      if (node.classList.contains('cm-line')) break
      node = node.parentElement
    }
    if (node === null || !node.classList.contains('cm-line')) return null
    const scrollerEl = node.closest('.cm-scroller')
    if (scrollerEl === null) return null
    clearLineHighlight()
    const onScroll = (): void => {
      if (paintQueued) return
      paintQueued = true
      window.requestAnimationFrame(paintRangeLines)
    }
    activeRange = { scroller: scrollerEl as HTMLElement, view, start: startLine, end: endLine, onScroll }
    scrollerEl.addEventListener('scroll', onScroll, { passive: true })
    paintRangeLines()
    return node
  } catch {
    // Best-effort decoration: never break the jump on a DOM drift.
    return null
  }
}

/**
 * Center one `.cm-line` element inside its `.cm-scroller` viewport.
 * `tolerance` skips sub-pixel/near-center nudges; when the line is scrolled
 * fully OUT of view the call does nothing, so post-jump verification passes
 * never yank the viewport back after the user scrolls away on purpose.
 */
function centerLineElement(el: HTMLElement, tolerance = 0): void {
  const scroller = el.closest('.cm-scroller')
  if (scroller === null) return
  const scrollerRect = scroller.getBoundingClientRect()
  const lineRect = el.getBoundingClientRect()
  // Only adjust while the line is still (at least partially) on screen.
  if (lineRect.bottom < scrollerRect.top || lineRect.top > scrollerRect.bottom) return
  const delta = (lineRect.top + lineRect.height / 2) - (scrollerRect.top + scrollerRect.height / 2)
  if (Math.abs(delta) <= tolerance || tolerance === 0 && delta === 0) return
  scroller.scrollTop += delta
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
      meta: ref.line !== undefined
        ? { line: ref.line, endLine: ref.endLine, column: ref.column }
        : undefined,
    },
    sessionId !== undefined ? { sessionId, cwd } : undefined,
  )

  if (ref.line !== undefined) scheduleJump(bs, absolute, ref.line, ref.endLine)
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
    `.${LINE_CLASS}{background:rgba(64,140,255,.22)!important;box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary,#3b82f6);}`,
  ].join('\n')
  document.head.appendChild(tag)
  return tag
}

function tooltipFor(ref: FileRef): string {
  if (ref.line === undefined) return '打开文件 · open file'
  const range = ref.endLine !== undefined && ref.endLine !== ref.line
    ? `${ref.line}-${ref.endLine}`
    : `${ref.line}`
  return `打开并选中第 ${range} 行 · open lines ${range}`
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

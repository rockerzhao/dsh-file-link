window.__ModuleLoader__.load({
	id: "dsh-file-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region src/client/index.ts
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
		const inject = ["sessions", "workspaces"];
		/** Whether a string plausibly names a file (not an arbitrary code token). */
		function looksLikePath(text) {
			if (/^[A-Za-z]:[\\/]/.test(text)) return true;
			if (text.startsWith("/") || text.startsWith("\\")) return true;
			if (/[\\/]/.test(text)) return true;
			return false;
		}
		/**
		* Parse a file reference out of an inline-code token's text.
		* Supported shapes: `path`, `path:line`, `path:line:col`, `path#Lline`.
		* The path part must look like a real path so ordinary prose (`12:30`) is
		* never treated as a jump target.
		*/
		function parseFileRef(raw) {
			const text = raw.trim();
			if (text === "" || text.length > 512) return null;
			const hash = /^(.*?)#L(\d+)(?:-L?(\d+))?$/.exec(text);
			if (hash !== null && looksLikePath(hash[1])) return {
				path: hash[1],
				line: Number(hash[2]),
				endLine: hash[3] !== void 0 ? Number(hash[3]) : void 0
			};
			const col = /^(.*):(\d+):(\d+)$/.exec(text);
			if (col !== null && looksLikePath(col[1])) return {
				path: col[1],
				line: Number(col[2]),
				column: Number(col[3])
			};
			const range = /^(.*):(\d+)-(\d+)$/.exec(text);
			if (range !== null && looksLikePath(range[1])) {
				const a = Number(range[2]);
				const b = Number(range[3]);
				return {
					path: range[1],
					line: Math.min(a, b),
					endLine: Math.max(a, b)
				};
			}
			const line = /^(.*):(\d+)$/.exec(text);
			if (line !== null && looksLikePath(line[1])) return {
				path: line[1],
				line: Number(line[2])
			};
			if (looksLikePath(text)) return { path: text };
			return null;
		}
		function isAbsolutePath(path) {
			return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
		}
		/** Resolve a relative path against the session cwd (Windows and POSIX aware). */
		function resolvePath(cwd, path) {
			const cleaned = path.trim();
			if (isAbsolutePath(cleaned)) return cleaned;
			const base = (cwd ?? "").replace(/[\\/]+$/, "");
			if (base === "") return cleaned;
			const sep = base.includes("\\") ? "\\" : "/";
			return base + sep + cleaned.replace(/[\\/]+/g, sep);
		}
		function basename(path) {
			const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
			return at === -1 ? path : path.slice(at + 1);
		}
		function allLeavesOf(node) {
			if (node.kind === "leaf") return [node];
			return (node.children ?? []).flatMap(allLeavesOf);
		}
		function treeHasId(node, id) {
			if (node.id === id) return true;
			if (node.kind === "split") return (node.children ?? []).some((child) => treeHasId(child, id));
			return false;
		}
		/** Whether the target file's tab is the active tab of its pane (i.e. displayed). */
		function targetTabActive(bs, absolute) {
			const state = bs.getSnapshot().state;
			if (state === void 0) return false;
			for (const leaf of [...allLeavesOf(state.splits), ...allLeavesOf(state.bottomSplits)]) {
				const tab = (leaf.tabs ?? []).find((candidate) => candidate.path === absolute);
				if (tab !== void 0) return leaf.active === tab.id;
			}
			return false;
		}
		/**
		* The right sidebar must own the landing: better-sidebar's openTab lands in
		* the ACTIVE pane, so when that pane lives in the bottom panel we activate a
		* right-panel tab first, moving the active pane into the right tree.
		*/
		function forceRightPanelLanding(bs) {
			const state = bs.getSnapshot().state;
			if (state === void 0 || state.activePane === null) return;
			if (!treeHasId(state.bottomSplits, state.activePane)) return;
			for (const leaf of allLeavesOf(state.splits)) {
				const tabs = leaf.tabs ?? [];
				if (tabs.length === 0) continue;
				const tabId = leaf.active ?? tabs[0].id;
				bs.activateTab(tabId);
				return;
			}
		}
		/** Walk up from a `.cm-content` element reading CodeMirror's `cmTile` handle. */
		function editorViewOf(el) {
			let node = el;
			while (node !== null) {
				const tile = node.cmTile;
				if (tile !== void 0 && tile.root?.view !== void 0) return tile.root.view;
				node = node.parentElement;
			}
			return null;
		}
		/** Whether an element is currently laid out (displayed, not display:none). */
		function isVisible(el) {
			if (el.offsetParent !== null) return true;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}
		function cssEscape(value) {
			const globalCss = window.CSS;
			if (globalCss?.escape !== void 0) return globalCss.escape(value);
			return value.replace(/["\\]/g, "\\$&");
		}
		/**
		* Locate the CodeMirror content element for one absolute path: the editor
		* host's path input carries `title={path}`, so find it and take the nearest
		* ancestor that contains a `.cm-content`. Returns null when not mounted yet.
		*/
		function editorContentForPath(absolute) {
			let input = null;
			try {
				input = document.querySelector(`input[title="${cssEscape(absolute)}"]`);
			} catch {
				return null;
			}
			if (input === null) return null;
			let node = input;
			for (let depth = 0; depth < 8 && node !== null; depth += 1) {
				const cm = node.querySelector(".cm-content");
				if (cm !== null) return cm;
				node = node.parentElement;
			}
			return null;
		}
		let pending = null;
		/** Try once to find the target editor and jump; true when settled. */
		function tryJumpNow() {
			if (pending === null) return false;
			const { bs, absolute, line, endLine } = pending;
			if (!targetTabActive(bs, absolute)) return false;
			const byPath = editorContentForPath(absolute);
			const candidates = [];
			if (byPath !== null) candidates.push(byPath);
			for (const raw of Array.from(document.querySelectorAll(".cm-content"))) {
				const el = raw;
				if (el !== byPath) candidates.push(el);
			}
			for (const el of candidates) {
				if (!isVisible(el)) continue;
				const view = editorViewOf(el);
				if (view === null) continue;
				const doc = view.state.doc;
				if (doc.length === 0) continue;
				const startLine = Math.max(1, Math.min(line, doc.lines));
				const lastLine = endLine === void 0 ? startLine : Math.max(startLine, Math.min(endLine, doc.lines));
				const start = doc.line(startLine);
				const end = doc.line(lastLine);
				const head = end.to > start.from ? end.to : Math.min(start.from + 1, doc.length);
				try {
					let centerEffect;
					try {
						centerEffect = view.constructor.scrollIntoView?.(start.from, { y: "center" });
					} catch {
						centerEffect = void 0;
					}
					if (centerEffect !== void 0) view.dispatch({
						selection: {
							anchor: start.from,
							head
						},
						effects: centerEffect
					});
					else {
						view.dispatch({
							selection: { anchor: start.from },
							scrollIntoView: true
						});
						view.dispatch({ selection: {
							anchor: start.from,
							head
						} });
					}
				} catch {}
				if (!pending.dispatched) armBailListeners();
				const scrollerEl = el.closest(".cm-scroller");
				if (scrollerEl === null) continue;
				const startEl = findLineElement(view, scrollerEl, startLine);
				if (startEl === null) continue;
				if (scrollerEl.scrollHeight > scrollerEl.clientHeight + 4) {
					const sr = scrollerEl.getBoundingClientRect();
					const lr = startEl.getBoundingClientRect();
					if (lr.bottom <= sr.top || lr.top >= sr.bottom) continue;
				}
				const lineEl = establishRangeHighlight(view, el, startLine, lastLine);
				if (lineEl === null) continue;
				scheduleCenterVerification(lineEl);
				pending = null;
				return true;
			}
			return false;
		}
		/**
		* Cancel the convergence loop the moment the user takes over (any click, any
		* wheel). Re-dispatching a centered scroll past that point would fight the
		* user's own scrolling, which is worse than a missing highlight.
		*/
		function armBailListeners() {
			const p = pending;
			if (p === null || p.dispatched) return;
			p.dispatched = true;
			const bail = () => {
				document.removeEventListener("pointerdown", bail, true);
				document.removeEventListener("wheel", bail, true);
				if (pending === p) pending = null;
			};
			document.addEventListener("pointerdown", bail, true);
			document.addEventListener("wheel", bail, true);
		}
		/** Poll until the jump converges (or the deadline / a user action ends it). */
		function scheduleJump(bs, absolute, line, endLine) {
			pending = {
				bs,
				absolute,
				line,
				endLine,
				dispatched: false,
				bailed: false
			};
			const deadline = Date.now() + 5e3;
			const tick = () => {
				if (pending === null) return;
				if (Date.now() > deadline) {
					pending = null;
					return;
				}
				if (tryJumpNow()) return;
				window.setTimeout(tick, 50);
			};
			window.setTimeout(tick, 120);
		}
		const LINE_CLASS = "dsh-file-link-line";
		let activeRange = null;
		let paintQueued = false;
		/** Remove every overlay class in the document (detached nodes included). */
		function sweepLineClasses() {
			for (const el of Array.from(document.querySelectorAll(`.${LINE_CLASS}`))) el.classList.remove(LINE_CLASS);
		}
		/** Drop the current range highlight (called when a new jump lands). */
		function clearLineHighlight() {
			if (activeRange !== null) {
				activeRange.scroller.removeEventListener("scroll", activeRange.onScroll);
				activeRange.observer.disconnect();
				document.removeEventListener("pointerdown", activeRange.stopFollowing, true);
				activeRange = null;
			}
			sweepLineClasses();
		}
		/** Re-paint the overlay on the RENDERED lines inside the active range. */
		function paintRangeLines() {
			paintQueued = false;
			const ar = activeRange;
			if (ar === null) return;
			const doc = ar.view.state.doc;
			for (const raw of Array.from(ar.scroller.querySelectorAll(".cm-line"))) {
				const el = raw;
				const rect = el.getBoundingClientRect();
				let pos = null;
				try {
					pos = ar.view.posAtCoords({
						x: rect.left + 1,
						y: rect.top + rect.height / 2
					});
				} catch {
					pos = null;
				}
				if (pos === null) continue;
				let num = 0;
				try {
					num = doc.lineAt(pos).number;
				} catch {
					continue;
				}
				if (num >= ar.start && num <= ar.end) el.classList.add(LINE_CLASS);
			}
		}
		/** Map one rendered `.cm-line` element to its document line number (0 = unknown). */
		function lineNumberOfEl(view, el) {
			const rect = el.getBoundingClientRect();
			let pos = null;
			try {
				pos = view.posAtCoords({
					x: rect.left + 1,
					y: rect.top + rect.height / 2
				});
			} catch {
				pos = null;
			}
			if (pos === null) return 0;
			try {
				return view.state.doc.lineAt(pos).number;
			} catch {
				return 0;
			}
		}
		/**
		* Find the rendered `.cm-line` element for an exact line number. Returns null
		* while the target line is outside the rendered viewport — CodeMirror
		* virtualizes lines and `domAtPos` CLAMPS to the nearest rendered line, so an
		* unrendered target must never be located through domAtPos (that clamp is
		* what previously centered on a wrong line and left a freshly opened file's
		* range unpainted until the user scrolled).
		*/
		function findLineElement(view, scroller, target) {
			for (const raw of Array.from(scroller.querySelectorAll(".cm-line"))) {
				const el = raw;
				if (lineNumberOfEl(view, el) === target) return el;
			}
			return null;
		}
		/**
		* Establish the range overlay once the START line is actually rendered.
		* @param contentEl the editor's `.cm-content` element (locates the scroller).
		* @returns the VERIFIED start-line element, or null while the target is not
		* in the rendered viewport yet (the caller retries on later ticks).
		*/
		function establishRangeHighlight(view, contentEl, startLine, endLine) {
			try {
				const scrollerEl = contentEl.closest(".cm-scroller");
				if (scrollerEl === null) return null;
				const startEl = findLineElement(view, scrollerEl, startLine);
				if (startEl === null) return null;
				clearLineHighlight();
				const onScroll = () => {
					if (paintQueued) return;
					paintQueued = true;
					window.requestAnimationFrame(paintRangeLines);
				};
				const stopFollowing = (event) => {
					document.removeEventListener("pointerdown", stopFollowing, true);
					if (activeRange === null) return;
					activeRange.scroller.removeEventListener("scroll", activeRange.onScroll);
					activeRange.observer.disconnect();
					if (event.target instanceof Element && event.target.closest(".cm-scroller") !== null) sweepLineClasses();
					activeRange = null;
				};
				const onDomChange = () => {
					if (paintQueued) return;
					paintQueued = true;
					window.requestAnimationFrame(paintRangeLines);
				};
				const observer = new MutationObserver(onDomChange);
				observer.observe(scrollerEl, {
					childList: true,
					subtree: true
				});
				activeRange = {
					scroller: scrollerEl,
					view,
					start: startLine,
					end: endLine,
					onScroll,
					observer,
					stopFollowing
				};
				scrollerEl.addEventListener("scroll", onScroll, { passive: true });
				document.addEventListener("pointerdown", stopFollowing, true);
				paintRangeLines();
				return startEl;
			} catch {
				return null;
			}
		}
		/**
		* Self-correcting centering passes: re-measure from live rects shortly after
		* the jump and re-center only when the (verified) start line is still visible
		* yet clearly off-center — idempotent, and never fighting the user once they
		* scrolled the line away.
		*/
		function scheduleCenterVerification(lineEl) {
			const verify = () => centerLineElement(lineEl, 10);
			window.requestAnimationFrame(() => {
				window.requestAnimationFrame(verify);
			});
			window.setTimeout(verify, 220);
		}
		/**
		* Center one `.cm-line` element inside its `.cm-scroller` viewport.
		* `tolerance` skips sub-pixel/near-center nudges; when the line is scrolled
		* fully OUT of view the call does nothing, so post-jump verification passes
		* never yank the viewport back after the user scrolls away on purpose.
		*/
		function centerLineElement(el, tolerance = 0) {
			const scroller = el.closest(".cm-scroller");
			if (scroller === null) return;
			const scrollerRect = scroller.getBoundingClientRect();
			const lineRect = el.getBoundingClientRect();
			if (lineRect.bottom < scrollerRect.top || lineRect.top > scrollerRect.bottom) return;
			const delta = lineRect.top + lineRect.height / 2 - (scrollerRect.top + scrollerRect.height / 2);
			if (Math.abs(delta) <= tolerance || tolerance === 0 && delta === 0) return;
			scroller.scrollTop += delta;
		}
		function openRef(ctx, ref) {
			const snapshot = ctx.sessions.list.getSnapshot();
			const sessionId = snapshot.current;
			const cwd = sessionId !== void 0 ? snapshot.byId[sessionId]?.cwd : void 0;
			const absolute = resolvePath(cwd, ref.path);
			const bs = ctx.get("betterSidebar");
			if (bs === void 0) {
				ctx.workspaces.openPath(absolute);
				return;
			}
			forceRightPanelLanding(bs);
			bs.openTab({
				type: "editor",
				title: basename(absolute),
				path: absolute,
				id: `editor:${absolute}`,
				meta: ref.line !== void 0 ? {
					line: ref.line,
					endLine: ref.endLine,
					column: ref.column
				} : void 0
			}, sessionId !== void 0 ? {
				sessionId,
				cwd
			} : void 0);
			if (ref.line !== void 0) scheduleJump(bs, absolute, ref.line, ref.endLine);
		}
		function registerClickDelegation(ctx) {
			const onClick = (event) => {
				if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
				if (event.defaultPrevented) return;
				const target = event.target;
				if (!(target instanceof Element)) return;
				const code = target.closest("code");
				if (code === null) return;
				if (code.closest("a") !== null || code.closest("pre") !== null) return;
				const ref = parseFileRef(code.textContent ?? "");
				if (ref === null) return;
				event.preventDefault();
				event.stopPropagation();
				openRef(ctx, ref);
			};
			document.addEventListener("click", onClick, true);
			return () => document.removeEventListener("click", onClick, true);
		}
		const LINK_CLASS = "dsh-file-link";
		function injectStyles() {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-file-link";
			tag.textContent = [
				`code.${LINK_CLASS}{color:var(--dsw-alias-state-business-primary,var(--dsw-static-blue-450,#3b82f6));cursor:pointer;}`,
				`code.${LINK_CLASS}:hover{text-decoration:underline;}`,
				`.${LINE_CLASS}{background:rgba(64,140,255,.22)!important;box-shadow:inset 3px 0 0 var(--dsw-alias-state-business-primary,#3b82f6);}`
			].join("\n");
			document.head.appendChild(tag);
			return tag;
		}
		function tooltipFor(ref) {
			if (ref.line === void 0) return "打开文件 · open file";
			const range = ref.endLine !== void 0 && ref.endLine !== ref.line ? `${ref.line}-${ref.endLine}` : `${ref.line}`;
			return `打开并选中第 ${range} 行 · open lines ${range}`;
		}
		/** Decorate one <code> element when its text parses as a file reference. */
		function decorate(el) {
			if (el.classList.contains(LINK_CLASS)) return;
			const ref = parseFileRef(el.textContent ?? "");
			if (ref === null) return;
			el.classList.add(LINK_CLASS);
			el.setAttribute("title", tooltipFor(ref));
		}
		/** Scan the whole document once (cheap: parse only undecorated code elements). */
		function scanAll() {
			for (const raw of Array.from(document.querySelectorAll("code"))) decorate(raw);
		}
		/**
		* Keep the decoration alive across React re-renders: a debounced
		* MutationObserver re-scans after DOM churn (React may reset className on
		* the elements it owns; the observer re-applies the class + title).
		*/
		function registerStyling() {
			if (document.body === null) return () => {};
			const tag = injectStyles();
			let timer = null;
			const schedule = () => {
				if (timer !== null) return;
				timer = window.setTimeout(() => {
					timer = null;
					scanAll();
				}, 150);
			};
			const observer = new MutationObserver(schedule);
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				characterData: true
			});
			scanAll();
			return () => {
				observer.disconnect();
				if (timer !== null) window.clearTimeout(timer);
				tag.remove();
			};
		}
		function apply(ctx) {
			ctx.effect(() => registerClickDelegation(ctx), "dsh-file-link: click delegation");
			ctx.effect(() => registerStyling(), "dsh-file-link: link styling");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
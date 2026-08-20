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
			const hash = /^(.*?)#L(\d+)(?:-L?\d+)?$/.exec(text);
			if (hash !== null && looksLikePath(hash[1])) return {
				path: hash[1],
				line: Number(hash[2])
			};
			const col = /^(.*):(\d+):(\d+)$/.exec(text);
			if (col !== null && looksLikePath(col[1])) return {
				path: col[1],
				line: Number(col[2]),
				column: Number(col[3])
			};
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
			const { bs, absolute, line } = pending;
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
				if (line < 1 || line > doc.lines) {
					pending = null;
					return true;
				}
				const lineInfo = doc.line(line);
				const head = lineInfo.to > lineInfo.from ? lineInfo.to : Math.min(lineInfo.from + 1, doc.length);
				try {
					view.dispatch({
						selection: {
							anchor: lineInfo.from,
							head
						},
						scrollIntoView: true
					});
				} catch {}
				highlightTargetLine(view, lineInfo.from);
				pending = null;
				return true;
			}
			return false;
		}
		/** Poll until the async editor mount lets us jump (or a deadline passes). */
		function scheduleJump(bs, absolute, line) {
			pending = {
				bs,
				absolute,
				line
			};
			const deadline = Date.now() + 5e3;
			const tick = () => {
				if (pending === null) return;
				if (Date.now() > deadline) {
					pending = null;
					return;
				}
				if (tryJumpNow()) return;
				window.setTimeout(tick, 100);
			};
			window.setTimeout(tick, 150);
		}
		const LINE_CLASS = "dsh-file-link-line";
		let highlightedLine = null;
		let highlightTimer = null;
		function clearLineHighlight() {
			if (highlightTimer !== null) {
				window.clearTimeout(highlightTimer);
				highlightTimer = null;
			}
			if (highlightedLine !== null) {
				highlightedLine.classList.remove(LINE_CLASS);
				highlightedLine = null;
			}
		}
		/** Paint the target line with the overlay class for a few seconds. */
		function highlightTargetLine(view, from) {
			try {
				const loc = view.domAtPos(from);
				let node = loc.node instanceof HTMLElement ? loc.node : loc.node.parentElement;
				for (let depth = 0; depth < 6 && node !== null; depth += 1) {
					if (node.classList.contains("cm-line")) break;
					node = node.parentElement;
				}
				if (node === null || !node.classList.contains("cm-line")) return;
				clearLineHighlight();
				node.classList.add(LINE_CLASS);
				highlightedLine = node;
				highlightTimer = window.setTimeout(clearLineHighlight, 3500);
			} catch {}
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
					column: ref.column
				} : void 0
			}, sessionId !== void 0 ? {
				sessionId,
				cwd
			} : void 0);
			if (ref.line !== void 0) scheduleJump(bs, absolute, ref.line);
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
			return ref.line !== void 0 ? `打开并跳到第 ${ref.line} 行 · open at line ${ref.line}` : "打开文件 · open file";
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
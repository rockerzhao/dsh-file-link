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
		* `dsh-better-sidebar` is an OPTIONAL peer: when present the file opens in its
		* editor and jumps to the line; when absent we fall back to the host's system
		* open (`workspaces.openPath`), matching the default DSH behavior.
		*
		* The jump reuses the editor's own CodeMirror view through the public
		* `EditorView.findFromDOM` trick — CodeMirror writes a plain `cmTile` property
		* on its content DOM, so we can reach `view.state.doc` and `view.dispatch`
		* without importing any CodeMirror package or forking the editor.
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
		/** Whether an element is currently laid out (the active tab's editor). */
		function isVisible(el) {
			if (el.offsetParent !== null) return true;
			const rect = el.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}
		let pendingLine = null;
		let pendingColumn = null;
		/** Try once to find the active editor and jump; true when settled. */
		function tryJumpNow() {
			if (pendingLine === null) return false;
			const line = pendingLine;
			const column = pendingColumn;
			const editors = document.querySelectorAll(".cm-content");
			for (const raw of Array.from(editors)) {
				const el = raw;
				if (!isVisible(el)) continue;
				const view = editorViewOf(el);
				if (view === null) continue;
				const doc = view.state.doc;
				if (doc.length === 0) continue;
				if (line < 1 || line > doc.lines) {
					pendingLine = null;
					pendingColumn = null;
					return true;
				}
				const lineInfo = doc.line(line);
				const columnClamped = column === null ? 0 : Math.max(0, Math.min(column - 1, lineInfo.to - lineInfo.from));
				const anchor = lineInfo.from + columnClamped;
				try {
					view.dispatch({
						selection: { anchor },
						scrollIntoView: true
					});
				} catch {}
				pendingLine = null;
				pendingColumn = null;
				return true;
			}
			return false;
		}
		/** Poll until the async editor mount lets us jump (or a deadline passes). */
		function scheduleJump(line, column) {
			pendingLine = line;
			pendingColumn = column ?? null;
			const deadline = Date.now() + 5e3;
			const tick = () => {
				if (pendingLine === null) return;
				if (Date.now() > deadline) {
					pendingLine = null;
					pendingColumn = null;
					return;
				}
				if (tryJumpNow()) return;
				window.setTimeout(tick, 100);
			};
			window.setTimeout(tick, 150);
		}
		function openRef(ctx, ref) {
			const snapshot = ctx.sessions.list.getSnapshot();
			const sessionId = snapshot.current;
			const cwd = sessionId !== void 0 ? snapshot.byId[sessionId]?.cwd : void 0;
			const absolute = resolvePath(cwd, ref.path);
			const betterSidebar = ctx.get("betterSidebar");
			if (betterSidebar === void 0) {
				ctx.workspaces.openPath(absolute);
				return;
			}
			betterSidebar.openTab({
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
			if (ref.line !== void 0) scheduleJump(ref.line, ref.column);
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
		function apply(ctx) {
			ctx.effect(() => registerClickDelegation(ctx), "dsh-file-link: click delegation");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
# dsh-file-link

让 DSH 对话里出现的 `file:line` 引用变成可点击链接：点击后在 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的右侧编辑器里打开文件并**跳转到指定行**。

Clickable `file:line` references in DeepSeek Harness replies — click to open the file in the `dsh-better-sidebar` editor and jump to the line.

## 支持的形式 / Supported forms

| 写法 | 行为 |
|---|---|
| `` `D:\Project\idata2\ci\common\utils.sh:3` `` | 打开文件并跳到第 3 行 |
| `` `src/foo.ts:12:5` `` | 打开文件并跳到第 12 行第 5 列 |
| `` `src/foo.ts#L42` `` | 打开文件并跳到第 42 行 |
| `` `D:\Project\...\utils.sh` `` | 只打开文件（不跳行） |

路径可以是 Windows / POSIX 绝对路径，或相对于当前会话工作区的相对路径。

## 依赖 / Requirements

- DSH web（`dsh web`）
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) `>= 0.12.0`（可选但推荐：没有它时点击退化为系统默认打开，且无法跳行）

## 安装 / Install

```sh
dsh plugin --profile web add "github:rockerzhao/dsh-file-link#main"
```

然后重启 `dsh web`（bundle 层在启动时编排，热更新不适用）。

## 工作原理 / How it works

- 客户端半（`lib/client.js`）在文档上做捕获阶段的点击委托：命中行内 `<code>`（反引号包裹的路径）后解析 `file:line` / `file#Lline`。
- 通过 `ctx.betterSidebar.openTab({ type: 'editor', path, meta: { line } })` 在右侧编辑器打开文件。
- 跳行复用编辑器自身的 CodeMirror 视图：CodeMirror 会在其内容 DOM 上写一个公开的 `cmTile` 属性，插件据此拿到 `EditorView` 并 `dispatch` 一个目标行选区 + 滚动到位——不引入任何 CodeMirror 依赖，也不 fork 编辑器。

## 开发 / Development

```sh
pnpm install
pnpm build        # → lib/index.js + lib/client.js
```

本地联调：

```sh
cd D:\Project\harness && pnpm build
dsh plugin --profile web add "link:D:\Project\harness"
# 重启 dsh web 后，硬刷新浏览器即可
```

## License

MIT

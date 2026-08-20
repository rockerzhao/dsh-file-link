/**
 * tsdown build for dsh-file-link: the host half (lib/index.js, ESM node) and
 * the browser client bundle (lib/client.js, CJS closure factory registered
 * with the DSH module loader under the package-name id `dsh-file-link`).
 *
 * The client bundle is dependency-free (DOM + the injected cordis services),
 * so nothing is externalized except the platform module seeds that would
 * otherwise collide with the shell's own module table.
 */
import { builtinModules } from 'node:module'

/** Module specifiers the web shell shares into its frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])

export default [
  {
    // Host half: the cordis plugin the bundle patch mounts.
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    // Client half: browser bundle registering with window.__ModuleLoader__.
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: CLIENT_EXTERNALS,
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['browser', 'import', 'require', 'default'],
      },
    },
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    plugins: [
      {
        name: 'dsh-file-link-client-purity',
        resolveId(source: string) {
          if (NODE_BUILTINS.has(source)) {
            throw new Error(
              `client bundle purity: Node builtin "${source}" cannot run in the browser module table`,
            )
          }
          if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
            throw new Error(
              `client bundle purity: "${source}" is not a platform module — cross-plugin value imports are forbidden; collaborate through cordis services`,
            )
          }
          return null
        },
      },
    ],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-file-link')}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      codeSplitting: false,
    },
  },
]

# Architecture Notes

This app is an Electron shell around a React/Vite renderer. If you already know
Node and React, the important bit is that Electron is not one JavaScript runtime:
it is a small set of cooperating processes with explicit bridges between them.

## Process Model

There are three app layers:

- `electron/main.ts`: the Electron main process. This owns native app concerns:
  windows, menus, dialogs, single-instance behavior, and IPC handlers.
- `electron/preload.ts`: the safe bridge injected into the renderer before the
  web app runs. This exposes a small typed API on `window.gitApi` and
  `window.appApi`.
- `src/renderer/ui/App.tsx`: the React app. This owns UI state and calls the
  preload APIs. It cannot import Node modules or call Git directly.

The renderer is intentionally sandboxed:

```ts
contextIsolation: true
nodeIntegration: false
```

That means any feature needing Node, the filesystem, native dialogs, shelling out
to Git, or native application menus must cross the preload/main boundary.

## IPC Flow

The usual flow is:

1. React calls `window.gitApi.someMethod(...)`.
2. `electron/preload.ts` maps that to `ipcRenderer.invoke('git:someMethod', ...)`.
3. `electron/main.ts` registers `ipcMain.handle('git:someMethod', ...)`.
4. The handler calls `GitService` or an Electron native API.
5. A serializable result is returned to React.

The shared contract lives in:

- `src/shared/api.ts`
- `src/shared/types.ts`

When adding an Electron-backed feature, update all of these together:

- shared type/API definition
- preload bridge
- main-process `ipcMain.handle` or `ipcMain.on`
- renderer call site
- usually `GitService` if the feature shells out to Git

If you only change the renderer, Vite hot reload is enough. If you change
`electron/main.ts` or `electron/preload.ts`, the Electron app must be restarted.
Hot reload does not update already-running main/preload code. This is why a new
renderer button can appear while its IPC handler is still missing.

## Native Menus

Application menus are owned by the main process, not React. Moving a normal
header control into the app menu means:

- build the native `Menu` in `electron/main.ts`
- update checked/disabled menu state from main-process state
- send menu selections to the renderer with `webContents.send(...)`
- expose a preload listener so React can subscribe
- usually send renderer state back to main so menu checks stay in sync

The theme menu is an example. The menu item lives in main, but the actual CSS
theme preference is stored by the renderer in `localStorage`, so both sides need
to synchronize.

## Git Integration

All Git operations are centralized in `electron/services/gitService.ts`.

The service shells out to the system `git` executable with `spawn` and returns
plain `GitResult<T>` objects. This keeps the renderer simple and avoids direct
Node access from React.

Important current behavior:

- status uses `git status --porcelain=v2 -z --branch --untracked-files=all`
- staged/unstaged diffs use `git diff` and `git diff --cached`
- amend mode changes the staged view to compare the index with `HEAD^`
- partial staging applies generated patches with `git apply --cached`
- untracked binary/text display is synthesized in the service
- push uses `git push --porcelain <remote> <branch>` plus selected flags

For risky Git operations, prefer explicit service methods over composing command
strings in the renderer.

## Renderer State

The renderer currently keeps most UI state in `App.tsx`. Persistent state uses
`localStorage` through `src/renderer/utils/storage.ts`.

Persisted keys include:

- open repo tabs
- active tab path
- commit message drafts by repo path
- theme/diff preferences
- resizable panel layouts

Tab IDs are generated per session, so persisted references should use repo paths,
not tab IDs.

## Layout

The app uses `react-resizable-panels` for split panes. Panel sizes are persisted
manually with `onLayoutChanged` and `localStorage`.

The core layout is:

- tab bar
- branch strip
- left file column
  - unstaged flat list
  - staged flat list
- right column
  - diff pane
  - commit/push controls
- status bar

The right-pane diff actions are intentionally context-menu driven.

## Packaging

Vite builds the renderer into `dist/`.

TypeScript builds Electron main/preload into `dist-electron/`.

Electron Forge packages the app from `forge.config.cjs`.

Important packaged-path detail:

```ts
main: "dist-electron/electron/main.js"
```

Because packaged `main.js` runs from `dist-electron/electron`, production loads
the renderer with:

```ts
path.join(__dirname, '../../dist/index.html')
```

Using `../dist/index.html` produced a blank packaged window because it resolved
inside the wrong folder in `app.asar`.

## Package Size

The unpacked macOS app is large mostly because Electron itself is large. Most of
the size is in `Contents/Frameworks`.

Renderer-only libraries should generally be `devDependencies`, because Vite
bundles them into the renderer assets. If they are in `dependencies`, Forge may
copy them into `app.asar` as runtime packages, which can inflate app size
substantially.

Current production runtime code should be small; after pruning renderer-only
dependencies, `app.asar` should be around low single-digit MB.

## Dev Server

`npm run dev` runs two processes:

- Vite renderer server on `127.0.0.1:5173`
- Electron pointed at that Vite URL

The dev Electron script clears `ELECTRON_RUN_AS_NODE`. This matters because if
that environment variable is set, launching Electron can drop into Node behavior
instead of running the app.

If `5173` is already occupied, stop the old dev server before starting another.
Also remember that a running Electron instance holds the app's single-instance
lock.

## Single Instance and `ggs`

The `ggs` helper resolves the current directory to a Git repo root and launches
Git Guis with:

```sh
--repo /path/to/repo
```

The main process calls `app.requestSingleInstanceLock()`. If another launch
happens, Electron sends a `second-instance` event to the existing app. The main
process then forwards the repo path to the renderer via `app:openRepositoryPath`.

This means command-line open/focus behavior crosses every Electron boundary:

CLI -> main process argv -> single-instance event -> preload listener -> React.

The packaged app includes `bin/ggs` as an unpacked Forge `extraResource`, because
shells cannot execute a script from inside `app.asar`. The native app menu item
`Git Guis > Install Terminal Helper` is main-process code: it finds a writable
shell bin directory, then symlinks that bundled helper to `ggs`.

## When To Use Main, Preload, Or Renderer

Use the renderer for:

- normal UI state
- layout
- localStorage preferences
- presenting Git results
- text selection/context menus inside the diff pane

Use preload for:

- exposing a narrow typed API to React
- translating renderer calls into IPC
- subscribing to main-process events

Use main for:

- native menus
- native dialogs
- app lifecycle
- single-instance behavior
- shell/trash/native OS APIs
- registering IPC handlers

Use `GitService` for:

- any Git command
- filesystem reads needed to describe Git data
- translating command output into typed results

## Common Gotchas

- Main/preload changes require restarting Electron, not just Vite hot reload.
- Renderer code may briefly run in a browser-like Vite context; optional chaining
  around `window.appApi` avoids dev-only crashes.
- IPC methods must be added in four places: shared type, preload, main, and
  renderer.
- App menus cannot directly call React state setters; they communicate through
  IPC events.
- Packaged file paths are relative to compiled output, not source files.
- Generated inspection files in the repo root can be picked up by Biome.
- Commit messages should be passed to Git verbatim; formatting user-written
  commit text in the app can be destructive.

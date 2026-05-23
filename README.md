# Git Guis

A tabbed, `git-gui`-style desktop app built with Electron, React, Vite, and the
Git CLI.

## Setup

```sh
npm install
```

## Development

Run the renderer dev server and Electron app together:

```sh
npm run dev
```

This starts Vite on `http://127.0.0.1:5173/` and launches Electron against it.
The Electron dev script clears `ELECTRON_RUN_AS_NODE` so Electron runs as the app
runtime even if that variable is set in your shell.

## Command Line Helper

Link the local `ggs` helper into your shell:

```sh
npm link
```

Then run it from inside any Git repository:

```sh
ggs
```

It resolves the current directory to the repository root, opens Git Guis, and
adds or focuses that repository tab. You can also pass a path:

```sh
ggs ../some-repo
```

On macOS the helper looks for `Git Guis.app` in `/Applications`,
`~/Applications`, then the local Forge package output. You can override that
with:

```sh
GIT_GUIS_APP="/path/to/Git Guis.app" ggs
```

## Checks

Run Biome and TypeScript:

```sh
npm run check
```

Apply Biome formatting and safe fixes:

```sh
npm run check:fix
```

## Production Build

Build renderer and Electron output:

```sh
npm run build
```

Outputs:

- `dist/` for the Vite renderer build
- `dist-electron/` for compiled Electron main/preload code

## Local App Package

Create a local unpacked app:

```sh
npm run package
```

Output:

- `out/Git Guis-darwin-arm64/Git Guis.app` on Apple Silicon macOS

## Distributables

Create Forge distributables:

```sh
npm run make
```

Output:

- `out/make/`

Current configured makers:

- macOS: zip
- Windows: Squirrel
- Linux: deb, rpm

Only macOS is actively verified right now.

## Icons

Forge is configured with `assets/icon` as the icon base path.

Expected files:

- `assets/icon.png` source icon
- `assets/icon.icns` for macOS
- `assets/icon.ico` for Windows

The current icon files were generated from `assets/icon.png`, a transparent
`1024x1024` RGBA PNG.

## Useful Commands

```sh
npm run dev       # run Vite + Electron
npm run check     # Biome + TypeScript
npm run build     # production build
npm run package   # local .app package
npm run make      # distributable artifacts
```

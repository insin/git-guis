<p align="center">
  <img src="assets/icon.png" width="128" height="128">
</p>

# Git Guis

Git Guis is a partial clone of `git gui` (just the bits I use) which fixes the following issues I have as a long-time enjoyer of `git gui` as a separate workspace for reviewing changes and building commits:

- `git gui` isn't tabbed, so you need a separate window per repo
- The `wish` runtime misbehaves in the macOS Dock, leaving ghost entries
- There's no keyboard shortcut for staging/unstaging selected lines

It also adds a new branch pane which contains just the bits of `gitk` I use (checkout, cherry-pick and reset).

![Screenshot of Git Guis](screenshot.png)

## Development

Requires Node.js, npm, and Git.

```sh
npm install
npm run dev
```

`npm run dev` starts Vite on `http://127.0.0.1:5173/` and launches Electron.

Run Biome and TypeScript checks:

```sh
npm run check
```

Apply Biome formatting and safe fixes:

```sh
npm run check:fix
```

## Builds

```sh
npm run build     # build renderer and Electron code
npm run package   # create an unpacked application
npm run make      # create configured distributables
npm run make:mac  # create an Apple Silicon macOS zip
```

Build output is written to `dist/`, `dist-electron/`, and `out/`.

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
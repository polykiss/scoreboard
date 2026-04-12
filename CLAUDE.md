# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

This repository is an **initial scaffold** — as of the latest commit (`Initial scaffold`), the only tracked files are `package.json`, `package-lock.json`, and `.gitignore`. There is no source code, no README, no tests, and no build/lint configuration yet. Future work will need to create these from scratch.

## Stack

- **Runtime:** Node.js, CommonJS (`"type": "commonjs"` in `package.json`)
- **Dependencies:** `express` ^5.2.1 and `ws` ^8.20.0 — the combination of an HTTP framework and a WebSocket library, plus the project name "scoreboard", implies the intended architecture is an HTTP server serving a scoreboard UI/API with realtime updates pushed over WebSockets.
- **Entry point:** `package.json` declares `main: "index.js"`, but that file does not yet exist.

## Persistence

`.gitignore` excludes `state.json` alongside `node_modules/`, `*.log`, `.DS_Store`, and `.env`. This strongly suggests state is intended to be persisted to a local `state.json` file rather than a database. Treat `state.json` as runtime data — never commit it.

## Scripts

`package.json` currently has no real scripts — only the default `npm test` stub that exits with an error. There is no `start`, `build`, `lint`, or real `test` script yet. When adding functionality, wire up the corresponding npm scripts so future instances have a canonical way to run things.

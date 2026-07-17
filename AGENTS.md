# AGENTS.md

For project architecture, gameplay systems, and coding discipline, read
`CLAUDE.md` (root) and `docs/HANDOFF.md` first — they are the authoritative
orientation for this repo.

## Cursor Cloud specific instructions

This is a **100% static site** (vanilla HTML/CSS/JS). There is **no package
manager, no build step, and no test framework** — do not add any (it breaks the
project premise; see `CLAUDE.md`). `node` and `python3` are preinstalled, so the
startup update script has nothing to install.

- **Run it (dev):** serve the repo root over HTTP, e.g. `python3 -m http.server 8000`,
  then open `http://localhost:8000/`. It also runs directly from `file://`, but a
  real HTTP origin is needed for Supabase auth redirects. Do not use a
  build/production command — there isn't one.
- **Lint / sanity check:** there is no linter; the repo's sanity check is
  `for f in js/*.js; do node --check "$f"; done` (per `docs/HANDOFF.md`).
- **Tests:** no test suite exists. For non-trivial logic, `docs/HANDOFF.md` §11
  describes a headless Node `vm` harness pattern (load all `js/*.js` into ONE
  shared `vm` context so cross-file top-level `const`s resolve like the browser).
- **Cloud/Supabase is optional and already configured** in `js/cloud-config.js`
  (live project). The game runs fully in **guest mode** with no login, so core
  features (Exchange, Fleet, Bazaar, Star Map) are testable without credentials.
  Leaving `js/cloud-config.js` blank forces local-only mode.
- **Scripts load as plain globals in dependency order** from `index.html` (no
  modules). If you add a `js/*.js` file, register its `<script>` in the correct
  order — see the load-order list in `docs/HANDOFF.md` §2.
- **Layout/visual/animation changes cannot be verified headlessly** — test those
  in a browser.

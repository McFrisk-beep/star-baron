# CLAUDE.md — Cosmocrat

Guidance for AI coding agents working in this repo. The coding discipline below
adopts **ponytail** — "lazy senior developer" mode — from
https://github.com/DietrichGebert/ponytail (MIT). For the always-on plugin +
slash commands, install it in your local Claude Code client:

    /plugin marketplace add DietrichGebert/ponytail
    /plugin install ponytail@ponytail

## Project constraints (already true — keep them that way)

- **Phase 1 is a 100% static site:** HTML/CSS/vanilla JS. No backend, no build
  step, no framework, no bundler, no package manager.
- Must run from `file://` *and* GitHub Pages. Game data loads as plain
  `<script>` globals so there are no `fetch()` / CORS issues locally.
- Don't add a framework or tooling to "tidy" things up — that breaks the
  premise. The best dependency is the one you don't add.

## Coding discipline — write the least code that works

Before writing code, take the **first rung that holds**:

1. **YAGNI** — does this need to exist at all? Skip speculative work.
2. **Standard library** — already provided by JS? Use it.
3. **Native platform** — can HTML/CSS/the browser do it (form validation,
   `<details>`, CSS animation/transitions, `localStorage`)? Prefer that over JS.
4. **Existing code** — reuse what's already in the repo; don't add a dependency
   for a minor need.
5. **One line** — if it fits in one line, stop there.
6. **Last resort** — only then write the shortest working implementation.

Principles: deletion over addition; boring over clever; fewest files; shortest
diff wins. No premature abstraction (no single-implementation interfaces, no
factories for one product). After a change, say in one line what was skipped and
when it'd be worth adding.

## Where laziness STOPS (never cut these)

- Input validation at trust boundaries — user input, and **save data loaded
  from `localStorage` / cloud sync**.
- Error handling that prevents **save-data loss**.
- Security and accessibility basics.
- Anything the user explicitly asked for.

## Conventions

- Mark deliberate shortcuts with `// ponytail:` comments naming the ceiling and
  the upgrade path, e.g.
  `// ponytail: O(n^2) over ~12 commodities; index this if the list grows`.
- Non-trivial logic gets **one** runnable check (an assert-based demo or a tiny
  no-framework test). Trivial one-liners need nothing.

## Intensity

Default is **full** (enforce the ladder, keep explanations short). Say "lite" to
just flag lazier alternatives, "ultra" for one-liners + questioning the
requirements, or "stop ponytail" / "normal mode" to switch it off.

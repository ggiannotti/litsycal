## What changed

<!-- Plain words: what does a user (or a future reader of this code) get out of this PR, and why? -->

## How I tested it

<!-- Nested dev session, real session, a specific calendar setup... say what you actually ran through. -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm test` passes (and `tests/` gained a check if a pure module changed)
- [ ] `./scripts/check.sh` passes
- [ ] `CHANGELOG.md` has a human-readable entry under `[Unreleased]`
- [ ] New user-visible strings are wrapped in `_()` / `ngettext()`
- [ ] No static import of an optional typelib; no bare `connect()` in Shell-process code

## What changed

<!-- Plain words: what does a user (or a future reader of this code) get out of this PR, and why? -->

## How I tested it

<!-- Nested dev session, real session, a specific calendar setup... say what you actually ran through. -->

## Checklist

- [ ] `npm run lint` passes
- [ ] `./scripts/check.sh` passes
- [ ] `CHANGELOG.md` has a human-readable entry under `[Unreleased]`
- [ ] New user-visible strings are wrapped in `_()` / `ngettext()`
- [ ] No bare `connect()` in Shell-process code (use `connectObject()`)

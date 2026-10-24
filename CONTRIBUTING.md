# Contributing to Litsycal

Thanks for stopping by. Small, focused patches are the easiest to review.

## Prerequisites

- GNOME Shell 48, 49 or 50 (the versions in `metadata.json`)
- `gjs`, for the syntax check and the unit tests
- Node.js 22 and `npm`, for ESLint — run `npm ci` (see Setup) *before*
  `npm run lint` or `./scripts/check.sh`; both need `node_modules/` in place
- `gettext` (`msgfmt`), to validate translations
- `glib-compile-schemas` (usually in `libglib2.0-bin` / `glib2-devel`)
- Evolution Data Server, if you want to test with real calendars:

  ```bash
  # Debian/Ubuntu
  sudo apt install evolution-data-server gir1.2-edataserver-1.2 gir1.2-ecal-2.0 gir1.2-ical-3.0
  # Fedora
  sudo dnf install evolution-data-server
  ```

  Without it the extension still opens — grid and time-zone clocks work,
  there are just no calendars or events to show.

## Setup

```bash
git clone https://github.com/mlkonrad/litsycal.git
cd litsycal
npm ci
glib-compile-schemas schemas/
git config core.hooksPath .githooks   # runs scripts/check.sh before each push
```

To try your build, copy it into GNOME's extensions directory and enable it:

```bash
cp -r litsycal ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com
gnome-extensions enable litsycal@mlkonrad.github.com
```

On Wayland a Shell restart means logging out and back in. For faster
iteration, `./scripts/dev-session.sh` starts a nested Shell instead — kill
it and re-run after each JS change. Heads up if you test calendar edits
there: the nested session runs on its own D-Bus bus, so it gets its own
Evolution Data Server process. A change made from your real session won't
show up live inside it; restart the nested session (or make the change from
a client on its bus) to see it.

## Checks

Run these before opening a PR — CI runs the same set:

Run `npm ci` first (from Setup above) if you haven't yet — lint and
`check.sh` fail without `node_modules/`.

```bash
npm run lint
npm test            # pure-gjs tests: gjs -m tests/test-quickadd-time.js
./scripts/check.sh  # schema compile, lint, syntax check, msgfmt, tests
```

`scripts/check.sh` and `.github/workflows/ci.yml` are kept in sync on
purpose; if you change one, change the other.

## Debugging

Extension errors go to the GNOME Shell log:

```bash
gnome-extensions show litsycal@mlkonrad.github.com
journalctl /usr/bin/gnome-shell -b 0 --no-pager | grep -i litsycal
```

The first also shows the extension's state and any error it recorded.
A JS change only takes effect after a GNOME Shell restart (or a
disable/enable of the extension). During development
`./scripts/dev-session.sh` avoids the logout — but even there, kill it
and re-run after each JS change (see Setup above).

## Conventions

These are the ones review (here and on extensions.gnome.org) actually
checks:

- Signals in Shell-process code use `connectObject()` /
  `disconnectObject(owner)`, never bare `connect()`. `prefs.js` runs in the
  GTK process and is exempt.
- Don't import an optional typelib (Evolution Data Server, location
  services) with a static top-level `import`. Load it lazily inside a
  `try`/`await import(...)` so the extension still opens when it isn't
  installed.
- Comments only where they explain *why*, not what the next line does.
  Keep comments plain ASCII — no em dashes, arrows or box-drawing in them.
  Translatable user-facing strings may use proper typography.
- Wrap user-visible strings in `_()` (or `ngettext()` for plurals).
  Format-only hints like `yyyy-mm-dd` or `https://` stay literal — they're
  the format itself, not prose.
- Nothing is created, connected or scheduled at module scope. Everything
  set up in `enable()` is torn down in `disable()` (sources removed first,
  then signals, then resources, then `super.destroy()`).
- Shell-process files never import Gtk/Gdk/Adw; `prefs.js` never imports
  St/Clutter/Meta. `helpers.js` is Shell-only — prefs can't import it.
- Unit tests live in `tests/` and only cover the pure, Shell-independent
  modules (`quickAddParser.js`, `timeInput.js`) through plain `gjs`. If
  your change fits there, add a check in `tests/test-quickadd-time.js`.

Regenerate the translation template after adding a translatable string
(and say so in the PR):

```bash
npm run pot   # xgettext --language=JavaScript --keyword=_:1 --keyword=ngettext:1,2 --keyword=pgettext:1c,2 --from-code=UTF-8 --package-name=Litsycal --copyright-holder='Marlon Konrad' -o po/litsycal@mlkonrad.github.com.pot *.js
```

Validating what exists is just `msgfmt --check po/*.po -o /dev/null`.

## Pull requests

- One topic per PR. Say what changed and how you tested it.
- Tick through the checklist in the PR template (lint, tests, `check.sh`,
  CHANGELOG).
- Add a short, human-readable entry under `## [Unreleased]` in
  `CHANGELOG.md` — what a user would notice, not which function moved.

# Contributing to Litsycal

Thanks for stopping by. Small, focused patches are the easiest to review.

## Prerequisites

- GNOME Shell 48, 49 or 50 (the versions in `metadata.json`)
- `gjs`, for the syntax check in `scripts/check.sh`
- Node.js and `npm`, for ESLint. CI uses Node.js 22. Run `npm ci` (see
  Setup) before `npm run lint` or `./scripts/check.sh`; both need
  `node_modules/` in place.
- `gettext` (`msgfmt` and `xgettext`), to validate and update translations
- `glib-compile-schemas` (usually in `libglib2.0-bin` / `glib2-devel`)
- Evolution Data Server, for calendars and events. Litsycal imports its
  typelibs (`EDataServer`, `ECal`, `ICalGLib`) directly, so it is a hard
  dependency, not an optional one:

  ```bash
  # Debian/Ubuntu
  sudo apt install evolution-data-server gir1.2-edataserver-1.2 gir1.2-ecal-2.0 gir1.2-ical-3.0
  # Fedora
  sudo dnf install evolution-data-server
  ```

## Setup

```bash
git clone https://github.com/mlkonrad/litsycal.git
cd litsycal
npm ci
git config core.hooksPath .githooks   # runs scripts/check.sh before each push
```

To try your build, copy it into GNOME's extensions directory, compile the
settings schema there, and enable it:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com
rsync -a --exclude=.git --exclude=node_modules ./ ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/litsycal@mlkonrad.github.com/schemas/
gnome-extensions enable litsycal@mlkonrad.github.com
```

On Wayland a Shell restart means logging out and back in. For faster
iteration, `./scripts/dev-session.sh` starts a nested Shell instead; kill
it and re-run after each JS change. Heads up if you test calendar edits
there: the nested session runs on its own D-Bus bus, so it gets its own
Evolution Data Server process. A change made from your real session won't
show up live inside it; restart the nested session (or make the change from
a client on its bus) to see it.

## Checks

Run these before opening a PR. CI (`.github/workflows/ci.yml`) runs the
same set:

```bash
npm run lint
./scripts/check.sh  # schema compile, lint, gjs syntax check, msgfmt on po/*.po and the POT
```

Run `npm ci` first (from Setup above) if you haven't yet; lint and
`check.sh` fail without `node_modules/`.

## Debugging

Extension errors go to the GNOME Shell log:

```bash
gnome-extensions show litsycal@mlkonrad.github.com
journalctl /usr/bin/gnome-shell -b 0 --no-pager | grep -i litsycal
```

The first also shows the extension's state and any error it recorded.
A JS change only takes effect after a GNOME Shell restart. During
development `./scripts/dev-session.sh` avoids the logout, but even there,
kill it and re-run after each JS change (see Setup above).

## Conventions

- Signals in Shell-process code use `connectObject()` /
  `disconnectObject(owner)`, never bare `connect()`. `prefs.js` runs in the
  GTK process and is exempt.
- Comments only where they explain *why*, not what the next line does.
  Keep comments plain ASCII: no em dashes, arrows or box-drawing in them.
  Translatable user-facing strings may use proper typography.
- Wrap user-visible strings in `_()` (or `ngettext()` for plurals).
  Format-only hints like `yyyy-mm-dd` or `https://` stay literal; they're
  the format itself, not prose.
- Nothing is created, connected or scheduled at module scope. Everything
  set up in `enable()` is torn down in `disable()`.
- Shell-process files never import Gtk/Gdk/Adw; `prefs.js` never imports
  St/Clutter/Meta. `helpers.js` is Shell-only, so prefs can't import it.

Regenerate the translation template after adding a translatable string
(and say so in the PR). There is no npm script for this; run `xgettext`
directly:

```bash
xgettext --language=JavaScript --keyword=_:1 --keyword=ngettext:1,2 --keyword=pgettext:1c,2 --from-code=UTF-8 --package-name=Litsycal --copyright-holder='Marlon Konrad' -o po/litsycal@mlkonrad.github.com.pot *.js
```

Validating the existing translations is part of `scripts/check.sh`, or by
hand:

```bash
for po in po/*.po; do msgfmt --check "$po" -o /dev/null; done
```

## Pull requests

- One topic per PR. Say what changed and how you tested it.
- Tick through the checklist in the PR template (lint, `check.sh`,
  CHANGELOG).
- Add a short, human-readable entry under `## [Unreleased]` in
  `CHANGELOG.md`: what a user would notice, not which function moved.

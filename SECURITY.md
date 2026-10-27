# Security policy

## Reporting a vulnerability

Do **not** open a public issue with exploitation details or other
sensitive information.

This repository does not have GitHub Private Vulnerability Reporting
enabled, and no public email address is listed for the maintainer, so
there is no private advisory form or public email channel to send
details to today.

Instead, open a minimal public issue that only asks the maintainer
for a private contact channel for a security report — say nothing
about the problem itself beyond that.

Only share the technical details once a private channel has been
arranged through that route.

## Scope

Litsycal runs inside the GNOME Shell process, with the user's own
privileges — a bug in it can in principle affect the whole desktop
session, so please treat crashes, memory-unsafe input handling and
anything that acts on calendar data unexpectedly as worth reporting.

Relevant areas:

- Parsing of calendar data coming from Evolution Data Server (event
  fields, URLs, recurrence and alarm rules) — this is untrusted input
  synced from other people and servers.
- Actions taken on that data without a user gesture (opening links,
  launching apps, spawning commands).
- Credential or account handling: Litsycal has none of its own — accounts
  belong to GNOME Online Accounts / Evolution Data Server — but report it
  here if Litsycal ever appears to leak or misuse them.

Out of scope: vulnerabilities in GNOME Shell, Evolution Data Server or
the calendar backends themselves — report those upstream. If you're not
sure which side a problem sits on, use the same minimal-issue route
above (no sensitive details) and it'll be pointed in the right
direction.

Only the latest release on extensions.gnome.org and the `main` branch
are supported; there are no long-lived maintenance branches.

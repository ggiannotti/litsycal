# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub:
https://github.com/mlkonrad/litsycal/security/advisories/new (the
"Report a vulnerability" button on the Security tab). Please don't
open a public issue for security problems.

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
sure which side a problem sits on, use the same private reporting form
above and it'll be pointed in the right direction.

Only the latest release on extensions.gnome.org and the `main` branch
are supported; there are no long-lived maintenance branches.

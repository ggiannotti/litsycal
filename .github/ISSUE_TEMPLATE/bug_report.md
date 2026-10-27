---
name: Bug report
about: Something in Litsycal misbehaves or crashes
labels: bug
---

**What happened?**
<!-- A short, concrete description. What did you click, what did you expect, what happened instead? -->

**Steps to reproduce**
1.
2.
3.

**Environment**
- Litsycal version / how you installed it (extensions.gnome.org, source, distro package):
- GNOME Shell version (`gnome-shell --version`):
- Distribution and version:
- Evolution Data Server installed? (needed for calendars/events)
- Anything else unusual: multi-monitor, fractional scaling, other extensions...

**Extension state and logs**

Paste the output of:

```bash
gnome-extensions show litsycal@mlkonrad.github.com
```

If the Shell logged an error, find Litsycal's lines in the Shell log and
paste the relevant part (please trim it to the error and a few lines
around it, not the whole journal):

```bash
journalctl /usr/bin/gnome-shell -b 0 --no-pager | grep -i litsycal
```

**Screenshots**
<!-- If it's a visual glitch, a screenshot of the calendar/agenda helps a lot. -->

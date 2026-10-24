import GLib from 'gi://GLib';
import Gio  from 'gi://Gio';

import {MAX_EXTRA_WEEK_ROWS} from './helpers.js';

// Evolution Data Server typelibs (EDataServer/ECal/ICalGLib) aren't
// guaranteed to be installed - a static top-level import throws at module
// load and takes down the whole extension, so they're loaded lazily by
// _loadBackends() below (same pattern as Geoclue/GWeather in prefs.js).
// Every use below only runs once these are non-null (see _loadBackends()).
let EDataServer = null;
let ECal = null;
let ICalGLib = null;

// How often the registry's private main context is run (see _initRegistry()):
// quickly until the registry exists, so calendars load without delay, then
// every few seconds - how soon calendars added, removed, enabled or disabled
// elsewhere show up here. Event changes don't wait on this; they arrive
// through the clients' own views on the Shell's main context.
const REGISTRY_STARTUP_PUMP_MS  = 100;
const REGISTRY_PUMP_INTERVAL_S  = 5;
// Caps per _pumpRegistry() call: anything still pending is resumed on the
// next 100ms/5s tick, so a flooded context can't freeze the Shell.
const MAX_REGISTRY_PUMP_ITERATIONS = 100;
const REGISTRY_PUMP_BUDGET_US = 8000; // 8ms, in GLib monotonic µs

// EDS calendar backends report colour in whatever format they like - hex,
// "rgb(r,g,b)"/"rgba(r,g,b,a)" (Google's backend, after a colour change), or
// occasionally a named CSS colour. Normalizing to hex here, once, gives every
// consumer downstream (day-cell dots, agenda pills, the event dialog's
// calendar picker) one predictable format.
function normalizeColor(color, fallback = '#3584e4') {
    if (!color)
        return fallback;
    if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color))
        return color;
    const m = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
        const hex = n => Math.min(255, Math.max(0, Math.trunc(Number(n)))).toString(16).padStart(2, '0');
        return `#${hex(m[1])}${hex(m[2])}${hex(m[3])}`;
    }
    // Only a single-word named colour is safe to pass through to style=;
    // anything else (with ';', spaces or symbols) falls back.
    if (/^[a-z]+$/i.test(color))
        return color;
    return fallback;
}

// An EDS call cut short by destroy() cancelling this._cancellable: not a
// failure worth logging, and there's nothing left for its callback to update.
function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class CalendarManager {
    constructor(settings, onEventsChanged) {
        this._settings  = settings;
        this._onEventsChanged = onEventsChanged;
        this._clients   = new Map();   // uid -> {client, color, name}
        this._views     = new Map();   // uid -> {view} (live change listener)
        this._viewTokens = new Map();  // uid -> latest view request; see _startView()
        this._cancellable = new Gio.Cancellable();
        this._events    = [];
        this._byDate    = new Map();   // dateStr -> Event[] (sorted, kept in sync with _events)
        this._registry    = null;
        this._registryContext        = null;
        this._registryStartupPumpId  = null;
        this._registryPumpId         = null;
        this._year        = null;
        this._month       = null;
        this._available   = false;
        this._destroyed   = false;
        this._searchToken = 0; // see searchEvents() - discards stale/out-of-order results
        this._fetchToken  = 0; // see fetchMonth() - discards a superseded batch's stale onDone
        this._fetchSeq    = new Map(); // uid -> latest issued _fetchFromClient() seq; see there
        this._ingestedSeq = new Map(); // uid -> highest seq already ingested; see _fetchFromClient()
        this._disabled  = new Set(settings.get_strv('disabled-calendars'));
        settings.connectObject('changed::disabled-calendars', () => {
            this._disabled = new Set(settings.get_strv('disabled-calendars'));
            this._reindex();
            this._onEventsChanged(this._events);
        }, this);
        // GNOME Shell doesn't disable extensions before it exits, so
        // destroy() never runs then. The registry is freed during GJS's own
        // teardown instead, and its dispose dispatches whatever it still has
        // queued (see _initRegistry()) - which must not reach our handlers
        // while GJS is shutting down.
        global.connectObject('shutdown', () => this._registry?.disconnectObject(this), this);
        this._loadBackends();
    }

    // Init

    // Loads the optional Evolution Data Server typelibs dynamically: on a
    // system without them (e.g. Debian without evolution-data-server) the
    // import fails, and a static import would have taken down the whole
    // extension before any code ran. On failure _available stays false -
    // the calendar grid, badge and clocks keep working without events, and
    // isAvailable() already blocks create/search/edit in calendarWidget.js.
    // Never throws.
    async _loadBackends() {
        try {
            const [eds, ecal, ical] = await Promise.all([
                import('gi://EDataServer'),
                import('gi://ECal'),
                import('gi://ICalGLib'),
            ]);
            EDataServer = eds.default;
            ECal = ecal.default;
            ICalGLib = ical.default;
        } catch (e) {
            logError(e, 'CalendarManager: Evolution Data Server libraries not found - calendar events unavailable');
            return;
        }
        if (this._destroyed)
            return;
        this._initRegistry();
    }

    // The registry lives on a private main context, not the Shell's.
    // ESourceRegistry dispatches its signals (and its ESources') on whatever
    // context was thread-default when it was created, and its dispose drains
    // that same context. On the Shell's context, that drain ran from
    // whichever GC finally freed the registry - at Shell exit, GJS's own
    // teardown, where it dispatched GJS's promise-queue child source, whose
    // callback is NULL, and gnome-shell segfaulted on every logout. On a
    // private context the drain only ever runs EDS's own callbacks. Nothing
    // runs that context for us, so _pumpRegistry() does, on a timer.
    // Only the registry itself belongs on the private context: ECal clients
    // connected from its callbacks are pinned to the Shell's context in
    // _connectSource().
    _initRegistry() {
        this._registryContext = new GLib.MainContext();
        this._registryContext.push_thread_default();
        EDataServer.SourceRegistry.new(this._cancellable, (_obj, res) => {
            // Already removed when this arrives from destroy()'s last pump.
            if (this._registryStartupPumpId) {
                GLib.source_remove(this._registryStartupPumpId);
                this._registryStartupPumpId = null;
            }
            try {
                this._registry  = EDataServer.SourceRegistry.new_finish(res);
                if (this._registryPumpId) {
                    GLib.source_remove(this._registryPumpId);
                    this._registryPumpId = null;
                }
                this._registryPumpId = GLib.timeout_add_seconds(
                    GLib.PRIORITY_DEFAULT, REGISTRY_PUMP_INTERVAL_S, () => {
                        this._pumpRegistry();
                        return GLib.SOURCE_CONTINUE;
                    });
                this._available = true;

                this._registry.connectObject(
                    'source-added', (_r, src) => this._connectSource(src),
                    'source-removed', (_r, src) => this._dropSource(src.get_uid()),
                    'source-enabled', (_r, src) => this._connectSource(src),
                    'source-disabled', (_r, src) => this._dropSource(src.get_uid()),
                    this);
                this._loadSources();
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, 'CalendarManager: registry init failed');
            }
        });
        this._registryContext.pop_thread_default();
        if (this._registryStartupPumpId) {
            GLib.source_remove(this._registryStartupPumpId);
            this._registryStartupPumpId = null;
        }
        this._registryStartupPumpId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, REGISTRY_STARTUP_PUMP_MS, () => {
                this._pumpRegistry();
                return GLib.SOURCE_CONTINUE;
            });
    }

    // Dispatches whatever the registry has queued on its private context.
    // Bounded by iterations AND a time budget: one iteration dispatches
    // every ready callback, so the iteration cap alone can't bound the
    // work. Still pending past the deadline resumes on the next tick;
    // a single isolated iteration can itself exceed the budget (that
    // part is uncontrollable) - the loop just won't chain another one.
    _pumpRegistry() {
        // _initRegistry() may never have run (backends failed to load, or
        // destroy() beat the async load) - nothing to pump then.
        if (!this._registryContext)
            return;
        const deadline = GLib.get_monotonic_time() + REGISTRY_PUMP_BUDGET_US;
        let iterations = 0;
        while (this._registryContext.pending() && iterations++ < MAX_REGISTRY_PUMP_ITERATIONS &&
               GLib.get_monotonic_time() < deadline)
            this._registryContext.iteration(false);
    }

    _loadSources() {
        if (!this._registry)
            return;
        const sources = this._registry.list_sources(EDataServer.SOURCE_EXTENSION_CALENDAR);
        for (const src of sources) {
            if (src.get_enabled() && !this._clients.has(src.get_uid()))
                this._connectSource(src);
        }
    }

    _connectSource(source) {
        if (!source.get_enabled())
            return;
        if (!source.has_extension(EDataServer.SOURCE_EXTENSION_CALENDAR))
            return;

        const uid    = source.get_uid();
        const calExt = source.get_extension(EDataServer.SOURCE_EXTENSION_CALENDAR);
        const color  = normalizeColor(calExt.get_color());
        const name   = source.get_display_name();

        // A client dispatches everything (this callback included) on the
        // context that is thread-default when it's created. This can run
        // from the registry's creation callback, which GTask invokes with
        // the registry's private context pushed as thread-default (see
        // _initRegistry()), so the Shell's context is pushed explicitly.
        const shellContext = GLib.MainContext.default();
        shellContext.push_thread_default();
        ECal.Client.connect(source, ECal.ClientSourceType.EVENTS, 10, this._cancellable, (_obj, res) => {
            try {
                const client = ECal.Client.connect_finish(res);
                this._clients.set(uid, {client, color, name});
                if (this._year !== null) {
                    this._fetchFromClient(uid, this._year, this._month);
                    this._startView(uid, client);
                }
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, `CalendarManager: failed to connect to calendar source '${name}' (${uid})`);
            }
        });
        shellContext.pop_thread_default();
    }

    _dropSource(uid) {
        this._stopView(uid);
        // Clear the seq maps so a re-added source restarts its fetch sequence instead of inheriting a stale watermark.
        this._fetchSeq.delete(uid);
        this._ingestedSeq.delete(uid);
        if (!this._clients.delete(uid))
            return;
        this._events = this._events.filter(e => e.clientUid !== uid);
        this._reindex();
        this._onEventsChanged(this._events);
    }

    // Live view (change notifications)

    // get_view() is async, so two quick month changes can leave two requests
    // for the same source in flight. Every start/stop bumps that source's
    // token, and a response for an older token is dropped instead of
    // replacing (and leaking) the view that should stay.
    _startView(uid, client) {
        const token = this._bumpViewToken(uid);
        client.get_view(this._rangeSexp(this._year, this._month), this._cancellable, (_obj, res) => {
            try {
                const [, view] = client.get_view_finish(res);
                if (token !== this._viewTokens.get(uid))
                    return;
                const refresh = () => {
                    if (this._year !== null)
                        this._fetchFromClient(uid, this._year, this._month);
                };
                view.connectObject(
                    'objects-added', refresh,
                    'objects-modified', refresh,
                    'objects-removed', refresh,
                    this);
                this._views.set(uid, {view});
                view.start();
            } catch (e) {
                if (!isCancelled(e))
                    logError(e, `CalendarManager: failed to start live view for source ${uid}`);
            }
        });
    }

    _stopView(uid) {
        this._bumpViewToken(uid);
        const entry = this._views.get(uid);
        if (!entry)
            return;
        entry.view.disconnectObject(this);
        try {
            entry.view.stop();
        } catch {} // stop() can throw if the view is already stopped
        this._views.delete(uid);
    }

    _bumpViewToken(uid) {
        const token = (this._viewTokens.get(uid) ?? 0) + 1;
        this._viewTokens.set(uid, token);
        return token;
    }

    _restartViews() {
        for (const uid of this._views.keys())
            this._stopView(uid);
        for (const [uid, {client}] of this._clients)
            this._startView(uid, client);
    }

    // Manual refresh (Ctrl+Alt+R)
    // fetchMonth() below only re-reads whatever EDS already has cached
    // locally - it never asks a backend like Google's own to go check for
    // anything new; EDS polls that on its own schedule (commonly ~30 min),
    // so a plain fetchMonth() right after a remote change can visibly do
    // nothing. This asks each backend that supports it to sync now; any
    // resulting changes land in EDS's cache and reach us automatically via
    // the live view's own 'objects-added'/'objects-modified' signals
    // (_startView above), so there's no need to re-fetch here ourselves.
    refreshFromServer() {
        for (const {client} of this._clients.values()) {
            if (!client.check_refresh_supported())
                continue;
            client.refresh(this._cancellable, (obj, res) => {
                try {
                    obj.refresh_finish(res);
                } catch (e) {
                    if (!isCancelled(e))
                        logError(e, 'CalendarManager: refresh failed');
                }
            });
        }
    }

    // Fetch

    // onDone, if given, fires once every connected client has responded to
    // this specific call - not on the general live-update path (source
    // added/changed events also call _fetchFromClient for just one client,
    // without this aggregation). _fetchToken guards against a batch from a
    // superseded fetchMonth call (e.g. the user navigated to another month
    // again before this one's clients all finished) still counting down and
    // firing a stale onDone.
    fetchMonth(year, month, onDone) {
        this._year   = year;
        this._month  = month;
        this._events = [];
        this._reindex();
        const token = ++this._fetchToken;
        if (this._clients.size === 0) {
            this._onEventsChanged([]);
            onDone?.();
            return;
        }
        this._restartViews();
        const state = {pending: this._clients.size};
        for (const uid of this._clients.keys()) {
            this._fetchFromClient(uid, year, month, ingested => {
                if (token !== this._fetchToken) {
                    // Rescue path: fresh data for the same month (a cross-month batch is already barred) must not stay invisible.
                    if (ingested)
                        this._onEventsChanged(this._events);
                    return;
                }
                state.pending--;
                if (state.pending === 0) {
                    this._reindex();
                    this._onEventsChanged(this._events);
                    onDone?.();
                }
            }, true);
        }
    }

    // Search (independent of the month cache above)
    //
    // A one-off query across every connected calendar, over a wide-but-bounded
    // time window (+/-1 year - wide enough to find "that thing from a few
    // months back" without an unbounded query against a backend with years
    // of history). EDS does the text filtering itself (the (contains? ...)
    // clauses below run server/backend-side), so this stays fast even with
    // several calendars - never touches this._events/_byDate, the grid's own
    // month cache, so it can't disturb whatever's currently displayed.
    //
    // callback(events) fires once, with every match across every source,
    // sorted by date/time. Stale results - a slower-to-respond earlier
    // search finishing after a newer one already has - are silently
    // discarded via _searchToken rather than clobbering fresher results.
    searchEvents(text, callback) {
        const token = ++this._searchToken;
        const query = (text ?? '').trim();
        // Same disabled-calendar exclusion as getSources()/_reindex() - a
        // calendar the user hid shouldn't resurface through search, letting
        // a result navigate to and open an event from it anyway.
        const uids = [...this._clients.keys()].filter(uid => !this._disabled.has(uid));
        if (!query || uids.length === 0) {
            callback([]);
            return;
        }

        const now   = GLib.DateTime.new_now_local();
        const start = now.add_years(-1);
        const end   = now.add_years(1);
        const needle = this._escapeSexpString(query);
        const sexp = '(and ' +
            `(occur-in-time-range? (make-time "${this._stamp(start)}") (make-time "${this._stamp(end)}")) ` +
            '(or ' +
            `(contains? "summary" "${needle}") ` +
            `(contains? "description" "${needle}") ` +
            `(contains? "location" "${needle}")))`;

        // {pending, results} is one shared, mutable object rather than two
        // separate outer variables closed over from inside a loop - see
        // _searchClient below, called once per source instead of defining
        // the completion closure directly in this loop.
        const state = {pending: uids.length, results: []};
        for (const uid of uids)
            this._searchClient(uid, sexp, token, state, callback);
    }

    _searchClient(uid, sexp, token, state, callback) {
        const finishIfDone = () => {
            state.pending--;
            if (state.pending === 0) {
                state.results.sort((a, b) => `${a.date} ${a.time ?? ''}`.localeCompare(`${b.date} ${b.time ?? ''}`));
                callback(state.results);
            }
        };
        const entry = this._clients.get(uid);
        if (!entry) {
            finishIfDone();
            return;
        }
        const {client, color} = entry;
        client.get_object_list_as_comps(sexp, this._cancellable, (_obj, res) => {
            if (token !== this._searchToken)
                return; // superseded by a newer search - drop this result
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                const localTz = comps?.length ? this._resolveLocalTimezone() : null;
                for (const comp of comps ?? []) {
                    const ev = this._parseComp(comp, color, uid, localTz);
                    if (ev)
                        state.results.push(ev);
                }
            } catch (e) {
                if (isCancelled(e))
                    return; // cancelled (destroy): callback is moot, keep dropping
                logError(e, `CalendarManager: search failed for source ${uid}`);
            }
            finishIfDone();
        });
    }

    // Lisp string-literal escaping for the search text embedded above -
    // correctness (a title containing a literal `"` would otherwise corrupt
    // the S-expression), not a security boundary.
    _escapeSexpString(s) {
        return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    }

    _stamp(dt) {
        return `${dt.get_year()}${String(dt.get_month()).padStart(2, '0')}` +
               `${String(dt.get_day_of_month()).padStart(2, '0')}T000000Z`;
    }

    // Grid overflow buffer: the calendar can show up to 6 leading days from
    // the previous month (a partial first row) and, on the trailing side, up
    // to 6 days filling a partial last row plus MAX_EXTRA_WEEK_ROWS
    // dragged-in extra weeks (see calendarWidget.js's resize handle).
    // Fetching only makes sense in whole-day units, so this pads a bit past
    // the exact worst case rather than tracking it to the day.
    _rangeSexp(year, month) {
        const LEADING_OVERFLOW_DAYS  = 7;
        const TRAILING_OVERFLOW_DAYS = 7 + MAX_EXTRA_WEEK_ROWS * 7;

        const monthStart = GLib.DateTime.new_local(year, month, 1, 0, 0, 0);
        const rangeStart = monthStart.add_days(-LEADING_OVERFLOW_DAYS);
        const rangeEnd   = monthStart.add_months(1).add_days(TRAILING_OVERFLOW_DAYS);
        return '(occur-in-time-range? ' +
               `(make-time "${this._stamp(rangeStart)}") ` +
               `(make-time "${this._stamp(rangeEnd)}"))`;
    }

    // onDone (optional) fires once this one client's fetch finishes, with
    // true only if it actually ingested, false otherwise - used by
    // fetchMonth() above to know when every client in one batch has
    // responded. Every other caller (live-update refetch of a single
    // client) just omits it.
    _fetchFromClient(uid, year, month, onDone, batch = false) {
        const entry = this._clients.get(uid);
        if (!entry) {
            onDone?.(false);
            return;
        }
        const {client, color} = entry;

        // Per-client ingestion watermark: whoever was INGESTED last for
        // this uid wins - not whoever was started last. _fetchSeq only
        // issues a growing seq per fetch; _ingestedSeq records the highest
        // seq actually ingested. A success older than the watermark is a
        // stale response (a newer one already landed): don't ingest, but
        // still count the batch caller down (it dies on its own token
        // guard; for live callers with no onDone this is a no-op). A FAILED
        // newer fetch never touches the watermark, so an older fetch that
        // responds afterwards can still ingest - otherwise one failed
        // fetch would discard every older good response and leave stale
        // data in place forever.
        const seq = (this._fetchSeq.get(uid) ?? 0) + 1;
        this._fetchSeq.set(uid, seq);

        const sexp = this._rangeSexp(year, month);

        client.get_object_list_as_comps(sexp, this._cancellable, (_obj, res) => {
            let ingested = false;
            try {
                const [, comps] = client.get_object_list_as_comps_finish(res);
                if (year !== this._year || month !== this._month) {
                    onDone?.(false);
                    return;
                }
                if (seq < (this._ingestedSeq.get(uid) ?? 0)) {
                    onDone?.(false);
                    return;
                }
                this._ingestComps(comps ?? [], color, uid, !batch);
                this._ingestedSeq.set(uid, seq);
                ingested = true;
            } catch (e) {
                if (isCancelled(e))
                    return;
                logError(e, `CalendarManager: failed to fetch events for source ${uid}`);
                if (!batch)
                    this._onEventsChanged(this._events);
            }
            onDone?.(ingested);
        });
    }

    _ingestComps(comps, color, clientUid, notify = true) {
        this._events = this._events.filter(e => e.clientUid !== clientUid);

        const localTz = comps.length ? this._resolveLocalTimezone() : null;
        for (const comp of comps) {
            const ev = this._parseComp(comp, color, clientUid, localTz);
            if (ev)
                this._events.push(ev);
        }

        // Always reindex: _byDate must stay consistent with _events even
        // on the batch path (notify=false), since minute-tick readers
        // (badge/countdown) can run mid-batch. The saving of a batch is
        // skipping _onEventsChanged - the UI rebuild - until fetchMonth's
        // close, not skipping the (cheap) reindex.
        this._reindex();
        if (notify)
            this._onEventsChanged(this._events);
    }

    // The system's local timezone as an ICalGLib.Timezone usable with
    // convert_to_zone(). Re-resolved per call rather than cached on `this`
    // - it's a cheap in-process libical lookup, and caching would risk a
    // stale zone if the system timezone changes while litsycal keeps
    // running.
    _resolveLocalTimezone() {
        const localId = GLib.TimeZone.new_local().get_identifier();
        return ICalGLib.Timezone.get_builtin_timezone(localId);
    }

    // Converts a non-floating ICalGLib.Time to the system's local
    // wall-clock time. Returns null (caller keeps the original,
    // unconverted value) when the TZID can't be resolved to a real zone
    // (e.g. a non-IANA Windows/Exchange zone name) or the local zone
    // itself can't be resolved - same "leave it as-is" behavior this data
    // already got everywhere before timezone conversion existed, rather
    // than guessing.
    _convertToLocal(tObj, tzid, localTz) {
        if (!localTz)
            return null;
        if (tObj.is_utc())
            return tObj.convert_to_zone(localTz);
        const srcTz = ICalGLib.Timezone.get_builtin_timezone(tzid);
        if (!srcTz)
            return null;
        tObj.set_timezone(srcTz);
        return tObj.convert_to_zone(localTz);
    }

    // Shared by _ingestComps (month cache) and searchEvents (a separate,
    // one-off query - see below) so both build the exact same event shape
    // from a raw ECal component. Returns null (logging) rather than
    // throwing on a single malformed component, so one bad event never
    // takes down a whole batch.
    _parseComp(comp, color, clientUid, localTz = null) {
        try {
            const title = comp.get_summary()?.get_value() ?? '';
            const dtstart = comp.get_dtstart();
            let tObj = dtstart?.get_value();
            if (!tObj)
                return null;

            const isAllDay = tObj.is_date();

            // DTSTART/DTEND from EDS carry the event's original TZID (or
            // are UTC/floating); convert to local wall-clock time here so
            // every consumer of the returned `date`/`time` fields gets a
            // correct time for free, instead of the organizer's raw digits
            // silently mislabeled as the viewer's local time.
            let originalTzid = null;
            if (!isAllDay) {
                const tzid = dtstart.get_tzid();
                if (tzid || tObj.is_utc()) {
                    localTz ??= this._resolveLocalTimezone();
                    const converted = this._convertToLocal(tObj, tzid, localTz);
                    // Only report an originalTzid (and only display the
                    // converted digits) when conversion actually succeeded -
                    // otherwise tObj still holds the raw, unconverted digits
                    // and labeling them as "originally scheduled in <tzid>"
                    // would misrepresent a conversion that never happened.
                    // Plain UTC times (a trailing Z) get no originalTzid:
                    // many CalDAV/ICS feeds store every event that way, so
                    // it says nothing about the zone it was planned in.
                    if (converted) {
                        if (!tObj.is_utc())
                            originalTzid = tzid;
                        tObj = converted;
                    }
                }
            }

            const y = tObj.get_year();
            const m = tObj.get_month();
            const d = tObj.get_day();
            const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

            let time = null;
            let endDate = null;
            if (!isAllDay)
                ({time, endDate} = this._parseTimeRange(comp, tObj, date, localTz));
            else
                endDate = this._parseAllDayEnd(comp, date);

            const {notes, url, location, recurrence, alarm, recurrenceId, attendees} =
                this._parseMeta(comp);

            return {
                date, title, time, color, allDay: isAllDay, endDate,
                uid: comp.get_uid(), clientUid, notes, url, originalTzid,
                location, recurrence, alarm, recurrenceId, attendees,
            };
        } catch (e) {
            logError(e, `CalendarManager: failed to parse calendar component ${comp.get_uid() ?? '?'}`);
            return null;
        }
    }

    _parseTimeRange(comp, tObj, date, localTz = null) {
        const pad = n => String(n).padStart(2, '0');
        const startStr = `${pad(tObj.get_hour())}:${pad(tObj.get_minute())}`;
        const dtend = comp.get_dtend();
        let eObj = dtend?.get_value();
        if (eObj && !eObj.is_date()) {
            const eTzid = dtend.get_tzid();
            if (eTzid || eObj.is_utc()) {
                localTz ??= this._resolveLocalTimezone();
                eObj = this._convertToLocal(eObj, eTzid, localTz) ?? eObj;
            }
        }
        const endStr = eObj && !eObj.is_date()
            ? `${pad(eObj.get_hour())}:${pad(eObj.get_minute())}`
            : null;
        // This 'HH:MM - HH:MM' shape is split back apart by datesSpanned() and helpers.eventTimeRange().
        const time = endStr ? `${startStr} - ${endStr}` : startStr;

        let endDate = null;
        if (eObj) {
            const eDate = `${eObj.get_year()}-${String(eObj.get_month()).padStart(2, '0')}-${String(eObj.get_day()).padStart(2, '0')}`;
            if (eDate !== date)
                endDate = eDate;
        }
        return {time, endDate};
    }

    _parseAllDayEnd(comp, date) {
        // All-day DTEND;VALUE=DATE is exclusive: the last visible
        // day is DTEND - 1. Only a span past the start day earns an
        // endDate (DTEND = start+1 is a plain 1-day event, as
        // before); endDate is that last visible day, matching
        // datesSpanned()/formatEventWhen().
        const dtend = comp.get_dtend();
        const eObj = dtend?.get_value();
        if (eObj?.is_date()) {
            const last = GLib.DateTime.new_utc(
                eObj.get_year(), eObj.get_month(), eObj.get_day(), 0, 0, 0)?.add_days(-1);
            if (last) {
                const lastStr = `${last.get_year()}-${String(last.get_month()).padStart(2, '0')}-${String(last.get_day_of_month()).padStart(2, '0')}`;
                if (lastStr > date)
                    return lastStr;
            }
        }
        return null;
    }

    _parseMeta(comp) {
        let notes = null, url = null, location = null, recurrence = null, alarm = null,
            recurrenceId = null, attendees = [];
        const ic = comp.get_icalcomponent();
        if (ic) {
            notes = ic.get_description() || null;
            const up = ic.get_first_property(ICalGLib.PropertyKind.URL_PROPERTY);
            url = up ? up.get_value_as_string() || null : null;
            location = ic.get_location() || null;
            if (notes    === '')
                notes    = null;
            if (url      === '')
                url      = null;
            if (location === '')
                location = null;

            recurrence = this._parseRecurrence(ic);
            alarm      = this._parseAlarm(ic);
            attendees  = this._parseAttendees(ic);

            // Present only on one occurrence of a recurring series (never
            // on the master) - identifies which occurrence this is, so a
            // "delete this event only" can target it specifically.
            const ridProp = ic.get_first_property(ICalGLib.PropertyKind.RECURRENCEID_PROPERTY);
            recurrenceId = ridProp ? ridProp.get_value_as_string() || null : null;
        }
        return {notes, url, location, recurrence, alarm, recurrenceId, attendees};
    }

    // Only understands a plain FREQ/INTERVAL/UNTIL rule (what our UI can build).
    // Anything else (BYDAY, COUNT, multiple rules, ...) is kept as raw text so
    // editing an unrelated field never silently discards it.
    _parseRecurrence(ic) {
        const prop = ic.get_first_property(ICalGLib.PropertyKind.RRULE_PROPERTY);
        if (!prop)
            return null;
        try {
            const raw   = prop.get_value_as_string();
            const parts = Object.fromEntries(raw.split(';').map(kv => kv.split('=')));
            const isSimple = Object.keys(parts).every(k => ['FREQ', 'INTERVAL', 'UNTIL'].includes(k)) &&
                              ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(parts.FREQ);
            if (!isSimple)
                return {raw};
            // A malformed UNTIL/INTERVAL falls back to {raw}, preserving the original rule untouched.
            if (parts.UNTIL && !/^\d{8}(T.*)?$/.test(parts.UNTIL))
                return {raw};
            let interval = 1;
            if (parts.INTERVAL !== undefined) {
                interval = parseInt(parts.INTERVAL, 10);
                if (!Number.isFinite(interval) || interval < 1)
                    return {raw};
            }

            const until = parts.UNTIL
                ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}`
                : null;
            // Preserve UNTIL's time-of-day suffix (e.g. '100000Z') when the
            // source rule has one: the UI's until picker only edits the
            // date, and _buildRRuleLine() re-emits this suffix with whatever
            // date is current then. Date-only UNTILs stay suffix-less and
            // keep the historical end-of-day behaviour there.
            const tIdx = parts.UNTIL?.indexOf('T') ?? -1;
            const untilTime = tIdx >= 0 && parts.UNTIL.slice(tIdx + 1)
                ? parts.UNTIL.slice(tIdx + 1)
                : null;
            const rec = {
                freq: parts.FREQ,
                interval,
                until,
            };
            if (untilTime)
                rec.untilTime = untilTime;
            return rec;
        } catch {
            return {raw: prop.get_value_as_string() ?? ''};
        }
    }

    // Only understands a single DISPLAY alarm with a relative (before-start)
    // duration trigger (what our UI can build). Anything else (multiple
    // alarms, absolute triggers, EMAIL/AUDIO actions, ...) is kept as raw
    // VALARM blocks so editing an unrelated field never silently discards it.
    _parseAlarm(ic) {
        const n = ic.count_components(ICalGLib.ComponentKind.VALARM_COMPONENT);
        if (n === 0)
            return null;
        if (n > 1)
            return {raw: this._allValarmBlocks(ic)};

        const valarm = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        try {
            const actionProp = valarm.get_first_property(ICalGLib.PropertyKind.ACTION_PROPERTY);
            const action     = actionProp?.get_value_as_string() ?? '';
            const trigProp = valarm.get_first_property(ICalGLib.PropertyKind.TRIGGER_PROPERTY);
            if (!trigProp || action !== 'DISPLAY')
                return {raw: this._allValarmBlocks(ic)};

            // A relative trigger's raw form is a DURATION ("-PT10M", "PT0S", ...);
            // an absolute one is a DATE-TIME. dur.is_null_duration() can't tell
            // "explicitly zero" from "unset", so classify by raw form instead.
            const raw = trigProp.get_value_as_string() ?? '';
            if (!/^[+-]?P/i.test(raw))
                return {raw: this._allValarmBlocks(ic)};

            const dur = trigProp.get_trigger().get_duration();
            return {minutesBefore: Math.round(-dur.as_int() / 60)};
        } catch {
            return {raw: this._allValarmBlocks(ic)};
        }
    }

    _allValarmBlocks(ic) {
        const blocks = [];
        let v = ic.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (v) {
            blocks.push(v.as_ical_string().trim());
            v = ic.get_next_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
        return blocks;
    }

    // Read-only display data - only CN (display name) and PARTSTAT (RSVP
    // status) per ATTENDEE. Never fed back into a save: editing an event
    // patches only the fields our dialog exposes onto the live component
    // (see _applyFieldsToIcal below), so attendee data always stays
    // whatever the server last sent, untouched by us.
    _parseAttendees(ic) {
        const attendees = [];
        let prop = ic.get_first_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY);
        while (prop) {
            const email = (prop.get_value_as_string() ?? '').replace(/^mailto:/i, '');
            const cn        = prop.get_parameter_as_string('CN') || null;
            const partstat  = (prop.get_parameter_as_string('PARTSTAT') || '').toUpperCase();
            attendees.push({name: cn || email.split('@')[0], email, partstat});
            prop = ic.get_next_property(ICalGLib.PropertyKind.ATTENDEE_PROPERTY);
        }
        return attendees;
    }

    // Index

    _reindex() {
        this._byDate = new Map();
        for (const ev of this._events) {
            if (this._disabled.has(ev.clientUid))
                continue;
            for (const ds of this.datesSpanned(ev)) {
                let bucket = this._byDate.get(ds);
                if (!bucket) {
                    bucket = [];
                    this._byDate.set(ds, bucket);
                }
                bucket.push(ev);
            }
        }
        for (const bucket of this._byDate.values()) {
            bucket.sort((a, b) => {
                if (a.allDay && !b.allDay)
                    return -1;
                if (!a.allDay && b.allDay)
                    return  1;
                return (a.time ?? '').localeCompare(b.time ?? '');
            });
        }
    }

    getEventsForDate(ds) {
        return this._byDate.get(ds) ?? [];
    }

    // Dates (YYYY-MM-DD, inclusive) a multi-day event's dot/agenda entry
    // - and its calendar-grid hover highlight - should appear under: every
    // day it spans, not just its start day. Mirrors Itsycal's EventCenter,
    // which walks each event's date range and adds it to every day's
    // bucket rather than just the start date. Public because the hover
    // highlight (calendarWidget.js) needs the identical range.
    datesSpanned(ev) {
        if (!ev.endDate || ev.endDate === ev.date)
            return [ev.date];
        // A malformed end before the start would otherwise fabricate a
        // full MAX_SPAN_DAYS of buckets without ever hitting lastDate.
        if (ev.endDate < ev.date)
            return [ev.date];

        // An event ending exactly at midnight (e.g. 22:00 -> 00:00 next day)
        // occupies zero minutes of its DTEND date - treat the day before as
        // the last spanned day. Mirrors Itsycal's identical fixup ("Fixup
        // for endDates that are at midnight") in its hover-highlight code.
        let lastDate = ev.endDate;
        if (ev.time?.split(' - ')[1]?.trim() === '00:00') {
            const [ey, em, ed] = ev.endDate.split('-').map(Number);
            const prev = GLib.DateTime.new_local(ey, em, ed, 0, 0, 0)?.add_days(-1);
            if (prev) {
                lastDate = `${prev.get_year()}-${String(prev.get_month()).padStart(2, '0')}-${String(prev.get_day_of_month()).padStart(2, '0')}`;
                if (lastDate === ev.date)
                    return [ev.date];
            }
        }

        const [sy, sm, sd] = ev.date.split('-').map(Number);
        // new_local() returns null when local midnight doesn't exist that
        // day (e.g. a DST jump at 00:00, America/Santiago) - degrade to the
        // start day alone instead of crashing _reindex() on the null.
        let cur = GLib.DateTime.new_local(sy, sm, sd, 0, 0, 0);
        if (!cur)
            return [ev.date];
        const dates = [];
        // Guard against malformed ICS (an absurd DTEND would otherwise
        // bucket the event under decades of days). Sized for a real
        // long-running event - up to ~10 years - not just one year, or a
        // multi-year event would vanish from the index after its first year.
        const MAX_SPAN_DAYS = 3650;
        for (let i = 0; i < MAX_SPAN_DAYS; i++) {
            const ds = `${cur.get_year()}-${String(cur.get_month()).padStart(2, '0')}-${String(cur.get_day_of_month()).padStart(2, '0')}`;
            dates.push(ds);
            if (ds === lastDate)
                break;
            cur = cur.add_days(1);
            if (!cur)
                break;
        }
        return dates;
    }

    // iCal builder

    _buildRRuleLine(recurrence) {
        if (!recurrence)
            return [];
        if (recurrence.raw)
            return [`RRULE:${recurrence.raw}`];

        const pad = n => String(n).padStart(2, '0');
        let r = `FREQ=${recurrence.freq}`;
        if (recurrence.interval > 1)
            r += `;INTERVAL=${recurrence.interval}`;
        if (recurrence.until) {
            const [uy, um, ud] = recurrence.until.split('-').map(Number);
            // Re-emit the time-of-day the source UNTIL carried (see
            // _parseRecurrence); only a date-only source UNTIL, or one the
            // user typed fresh, gets the historical end-of-day stamp.
            r += `;UNTIL=${uy}${pad(um)}${pad(ud)}T${recurrence.untilTime || '235959Z'}`;
        }
        return [`RRULE:${r}`];
    }

    _buildValarmLines(alarm) {
        if (!alarm)
            return [];
        if (alarm.raw)
            return alarm.raw.flatMap(block => block.split(/\r?\n/).filter(Boolean));

        const min = Math.trunc(alarm.minutesBefore);
        if (!Number.isFinite(min))
            return [];
        // A negative minutesBefore is an alarm *after* the start (parsed
        // from e.g. TRIGGER:PT10M): its duration is positive and unsigned.
        // Decomposing the signed value directly produced invalid output
        // like '-P-1DT-1H-10M', so decompose the magnitude and pick the
        // sign prefix from the original value. Zero/positives unchanged.
        const absMin = Math.abs(min);
        const days  = Math.floor(absMin / 1440);
        const rem   = absMin % 1440;
        const hours = Math.floor(rem / 60);
        const mins  = rem % 60;
        let trigger = 'PT0M';
        if (min > 0)
            trigger = '-P';
        else if (min < 0)
            trigger = 'P';
        if (min !== 0) {
            if (days)
                trigger += `${days}D`;
            if (hours || mins)
                trigger += `T${hours ? `${hours}H` : ''}${mins ? `${mins}M` : ''}`;
        }
        return [
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            'DESCRIPTION:Reminder',
            `TRIGGER:${trigger}`,
            'END:VALARM',
        ];
    }

    _buildICal(uid, fields) {
        const {
            title, date, allDay, hour, minute, endHour, endMinute, endDate,
            notes, url, location, recurrence, alarm,
        } = fields;
        const pad       = n => String(n).padStart(2, '0');
        const [y, m, d] = (date ?? '').split('-').map(Number);
        if (![y, m, d].every(Number.isFinite))
            throw new Error('Invalid date');
        const escText   = s => s.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');

        let dtLines;
        if (allDay) {
            // DTEND is exclusive, so it's the day after the last visible
            // day: endDate (when it's past the start) else the start itself.
            // Through GLib so month/year boundaries roll over, in UTC so no
            // DST shift applies.
            const [ly, lm, ld] = (endDate && endDate > date ? endDate : date).split('-').map(Number);
            if (![ly, lm, ld].every(Number.isFinite) || !GLib.DateTime.new_utc(y, m, d, 0, 0, 0))
                throw new Error('Invalid date');
            const lastDay = GLib.DateTime.new_utc(ly, lm, ld, 0, 0, 0);
            if (!lastDay)
                throw new Error('Invalid date');
            const next = lastDay.add_days(1);
            if (!next)
                throw new Error('Invalid date');
            dtLines = [
                `DTSTART;VALUE=DATE:${y}${pad(m)}${pad(d)}`,
                `DTEND;VALUE=DATE:${next.get_year()}${pad(next.get_month())}${pad(next.get_day_of_month())}`,
            ];
        } else {
            // Tagged with the system's own timezone rather than left floating:
            // _parseComp() shows/edits times as local wall-clock digits, and a
            // floating DTSTART/DTEND is reinterpreted as *each viewer's own*
            // local time by other clients - silently shifting the instant for
            // anyone not in this machine's timezone. An explicit TZID keeps
            // the instant fixed no matter who views it next.
            const tzid = GLib.TimeZone.new_local().get_identifier();
            const [ey, em2, ed2] = (endDate ?? date).split('-').map(Number);
            if (![ey, em2, ed2].every(Number.isFinite))
                throw new Error('Invalid date');
            const validTime = (v, max) => Number.isFinite(v) && v >= 0 && v <= max;
            if (!validTime(hour, 23) || !validTime(minute, 59) ||
                !validTime(endHour, 23) || !validTime(endMinute, 59))
                throw new Error('Invalid time');
            if (!GLib.DateTime.new_local(y, m, d, hour, minute, 0) ||
                !GLib.DateTime.new_local(ey, em2, ed2, endHour, endMinute, 0))
                throw new Error('Invalid date or time');
            dtLines = [
                `DTSTART;TZID=${tzid}:${y}${pad(m)}${pad(d)}T${pad(hour)}${pad(minute)}00`,
                `DTEND;TZID=${tzid}:${ey}${pad(em2)}${pad(ed2)}T${pad(endHour)}${pad(endMinute)}00`,
            ];
        }

        return [
            'BEGIN:VEVENT',
            `UID:${uid}`,
            `SUMMARY:${escText(title ?? '')}`,
            ...dtLines,
            ...notes    ? [`DESCRIPTION:${escText(notes)}`] : [],
            ...url      ? [`URL:${url.replace(/[\r\n]+/g, '')}`] : [],
            ...location ? [`LOCATION:${escText(location)}`] : [],
            ...this._buildRRuleLine(recurrence),
            ...this._buildValarmLines(alarm),
            'END:VEVENT',
        ].join('\r\n');
    }

    // Create

    createEvent(fields, sourceUid, onDone) {
        const entry = this._clients.get(sourceUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        let icalStr;
        try {
            icalStr = this._buildICal(GLib.uuid_string_random(), fields);
        } catch (e) {
            onDone?.(e);
            return;
        }
        const ical = ICalGLib.Component.new_from_string(icalStr);
        entry.client.create_object(ical, ECal.OperationFlags.NONE, this._cancellable, (_obj, res) => {
            try {
                entry.client.create_object_finish(res);
                onDone?.(null);
                if (this._year !== null)
                    this._fetchFromClient(sourceUid, this._year, this._month);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
            }
        });
    }

    // Update

    // Replaces just the properties our Edit dialog exposes (SUMMARY, DTSTART/
    // DTEND, DESCRIPTION, LOCATION, URL, RRULE, VALARMs) on the live component,
    // leaving everything else (ORGANIZER, ATTENDEE, SEQUENCE, conferencing
    // data, ...) untouched. Rebuilding the whole VEVENT from only our fields
    // and PUTting that as a full replacement would drop those other
    // properties, which Google's CalDAV backend rejects for meeting events
    // with a 409 (Conflict) - it won't accept a modification that strips a
    // meeting's organizer/attendees/conferencing structure.
    _applyFieldsToIcal(ical, fields) {
        const newIcal = ICalGLib.Component.new_from_string(this._buildICal(ical.get_uid(), fields));

        for (const kind of [
            ICalGLib.PropertyKind.SUMMARY_PROPERTY,
            ICalGLib.PropertyKind.DTSTART_PROPERTY,
            ICalGLib.PropertyKind.DTEND_PROPERTY,
            // RFC 5545 forbids DTEND and DURATION coexisting. The rebuilt
            // component never carries DURATION, so listing it here only
            // strips a stale one from an externally-created event - the
            // new DTEND above then stands alone.
            ICalGLib.PropertyKind.DURATION_PROPERTY,
            ICalGLib.PropertyKind.DESCRIPTION_PROPERTY,
            ICalGLib.PropertyKind.LOCATION_PROPERTY,
            ICalGLib.PropertyKind.URL_PROPERTY,
            ICalGLib.PropertyKind.RRULE_PROPERTY,
        ])
            this._replaceProperties(ical, newIcal, kind);

        let oldAlarm = ical.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (oldAlarm) {
            ical.remove_component(oldAlarm);
            oldAlarm = ical.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
        let newAlarm = newIcal.get_first_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        while (newAlarm) {
            ical.add_component(newAlarm.clone());
            newAlarm = newIcal.get_next_component(ICalGLib.ComponentKind.VALARM_COMPONENT);
        }
    }

    _replaceProperties(dest, src, kind) {
        let old = dest.get_first_property(kind);
        while (old) {
            dest.remove_property(old);
            old = dest.get_first_property(kind);
        }
        let prop = src.get_first_property(kind);
        while (prop) {
            dest.add_property(prop.clone());
            prop = src.get_next_property(kind);
        }
    }

    updateEvent(uid, clientUid, fields, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        entry.client.get_object(uid, null, this._cancellable, (_obj, res) => {
            let ical;
            try {
                [, ical] = entry.client.get_object_finish(res);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
                return;
            }

            try {
                this._applyFieldsToIcal(ical, fields);
            } catch (e) {
                onDone?.(e);
                return;
            }
            entry.client.modify_object(ical, ECal.ObjModType.ALL, ECal.OperationFlags.NONE, this._cancellable, (_obj2, res2) => {
                try {
                    entry.client.modify_object_finish(res2);
                    onDone?.(null);
                    if (this._year !== null)
                        this._fetchFromClient(clientUid, this._year, this._month);
                } catch (e) {
                    if (!isCancelled(e))
                        onDone?.(e);
                }
            });
        });
    }

    // Delete

    // opts: {scope: 'ALL' | 'THIS' | 'FUTURE', recurrenceId}. scope defaults to
    // 'ALL' (the whole series, or a non-recurring event); 'THIS'/'FUTURE' need
    // recurrenceId to identify which occurrence.
    deleteEvent(uid, clientUid, opts, onDone) {
        const entry = this._clients.get(clientUid);
        if (!entry) {
            onDone?.(new Error('Calendar not connected'));
            return;
        }

        const {scope = 'ALL', recurrenceId = null} = opts ?? {};
        if ((scope === 'THIS' || scope === 'FUTURE') && !recurrenceId) {
            onDone?.(new Error('Missing recurrence id'));
            return;
        }
        const modType = {
            ALL:    ECal.ObjModType.ALL,
            THIS:   ECal.ObjModType.THIS,
            FUTURE: ECal.ObjModType.THIS_AND_FUTURE,
        }[scope] ?? ECal.ObjModType.ALL;
        const rid = scope === 'ALL' ? null : recurrenceId;

        entry.client.remove_object(uid, rid, modType, ECal.OperationFlags.NONE, this._cancellable, (_obj, res) => {
            try {
                entry.client.remove_object_finish(res);
                onDone?.(null);
                this._events = this._events.filter(e => !(e.uid === uid && e.clientUid === clientUid &&
                    (rid == null || e.recurrenceId === rid)));
                this._reindex();
                this._onEventsChanged(this._events);
            } catch (e) {
                if (!isCancelled(e))
                    onDone?.(e);
            }
        });
    }

    // Accessors

    isAvailable() {
        return this._available;
    }

    getEvents()   {
        return this._events;
    }

    getSources()  {
        return [...this._clients.entries()]
            .filter(([uid]) => !this._disabled.has(uid))
            .map(([uid, {name, color}]) => ({uid, name, color}));
    }

    // Backs the New Event form's default calendar (see EventPanel's
    // constructor and _save() in eventDialog.js) - remembers whichever
    // calendar was picked last time, rather than always defaulting to
    // whatever getSources() happens to list first.
    getLastEventSourceUid() {
        return this._settings.get_string('last-event-calendar-uid');
    }

    setLastEventSourceUid(uid) {
        this._settings.set_string('last-event-calendar-uid', uid);
    }

    // Cleanup

    destroy() {
        this._destroyed = true;
        if (this._registryStartupPumpId) {
            GLib.source_remove(this._registryStartupPumpId);
            this._registryStartupPumpId = null;
        }
        if (this._registryPumpId) {
            GLib.source_remove(this._registryPumpId);
            this._registryPumpId = null;
        }
        // Keeps every in-flight EDS call from calling back into this manager
        // (and the calendar widget behind it) after teardown.
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        global.disconnectObject(this);
        for (const uid of [...this._views.keys()])
            this._stopView(uid);
        if (this._registry) {
            this._registry.disconnectObject(this);
            this._registry = null;
        }
        // One last run, now that everything above is cancelled and
        // disconnected: a registry creation still in flight then completes
        // (with CANCELLED) instead of sitting queued on a context nobody
        // runs anymore, keeping itself and the registry alive.
        this._pumpRegistry();
        this._registryContext = null;
        this._clients.clear();
    }
}

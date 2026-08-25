/* ================================================================
   RECALL v2 — app.js
   All behavior lives here; index.html is structure, styles.css is
   look. This file must load AFTER pdf.min.js (script order in
   index.html), because the worker config below needs pdfjsLib.
   ================================================================ */

// pdf.js needs to know where its background worker script lives.
// (Moved here from an inline <script> during the file split.)
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

/* ================================================================
   RECALL v2
   Features: manual card creation · flashcard review with SM-2
   spaced repetition · AI card generation (Claude, browser-direct).
   No server. Decks/cards live in localStorage; the API key too.
   ================================================================ */

const DAY = 24 * 60 * 60 * 1000;

/* ----------------------------------------------------------------
   1. DATA LAYER  (localStorage; immutable updates)
   ----------------------------------------------------------------
   Each card carries an `srs` object — the spaced-repetition state.
   Old cards saved before SM-2 existed get a default srs on load,
   so nothing breaks when the data model grows. */

const STORAGE_KEY = 'recall.data';

/* A brand-new card is "due now" so it shows up in the first session. */
function newSrs() {
  return { due: Date.now(), interval: 0, ease: 2.5, reps: 0, lapses: 0, last: null };
}

/* ── 1B. BACKUP SAFETY (feature #19) — pure ──────────────────────
   Sliced by 04 System/(C) test-backup.mjs. No browser, no state.

   `parseSavedData` exists because the old code answered "I cannot read your
   data" with "starting fresh" — it returned an empty library, which the next
   write then saved over data that was still fully recoverable. One click on
   "Create a deck" turned a fixable problem into a permanent one, and that is
   how the Descobrimentos deck was lost on 2026-07-26.

   Separating "is this readable?" from "load it" is what lets the answer be
   *refuse to write* instead of *pretend it is empty*. */

const BACKUP_STALE_DAYS = 7;
const MS_PER_DAY = 86400000;

/* ── Gamification data shape (feature #32) ──
   Lives HERE, in the persistence section, and not in the gamification block further
   down. loadData() calls both, and (C) test-backup / test-assignments / test-migration
   all lift THIS region out and evaluate it standalone — a reference to anything
   outside it throws a ReferenceError that takes the whole slice down and fake-fails
   every check in those suites. Found exactly that way on 2026-08-02. */
function emptyGamification() {
  return { freezes: 0, frozenDays: [], badges: [], earnedAt: 0 };
}

/* Every save before this feature has no `gamification` key at all, and an imported
   backup can carry anything. Degrade field by field rather than trusting the shape —
   the Progress screen reads this on every render. */
function normalizeGamification(g) {
  const src = (g && typeof g === 'object') ? g : {};
  const num = v => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
  return {
    freezes: num(src.freezes),
    frozenDays: Array.isArray(src.frozenDays) ? src.frozenDays.filter(d => typeof d === 'string') : [],
    badges: Array.isArray(src.badges) ? src.badges.filter(b => typeof b === 'string') : [],
    earnedAt: num(src.earnedAt)
  };
}

/* Every read path must hand back assignments that ALREADY carry gcalEventId
   (feature #33).

   A missing key reads as `undefined`, and `undefined` in the diff is not "no event":
   it compares unequal to everything, so every already-synced assignment would
   silently get a SECOND event on the next sync. Only a non-empty string can name a
   Google event — a number, null or "" all degrade to null.

   Defined HERE, at the top of 1B, and not down in the gcal block: (C) test-backup.mjs
   and (C) test-migration.mjs evaluate only the 1B slice, so a helper defined later is
   not in scope for the very functions below that call it. */
function normalizeGcalEventId(v) {
  return typeof v === 'string' && v ? v : null;
}

/* `pomodoros` (feature #34) is a FIFTH top-level key. A missing one must read as {},
   never undefined — every counter that reads it would otherwise throw or produce NaN.
   Arrays are rejected too: typeof [] is 'object', and an array here would accept
   numeric day keys and silently lose them on the next write.

   Defined HERE in 1B, next to parseSavedData, for the same reason normalizeGcalEventId
   is: (C) test-backup.mjs and (C) test-migration.mjs evaluate only the 1B slice, so a
   helper defined further down is not in scope for the functions below that call it. */
function normalizePomodoros(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function normalizeAssignmentsForGcal(list) {
  return (Array.isArray(list) ? list : [])
    .map(a => (a ? { ...a, gcalEventId: normalizeGcalEventId(a.gcalEventId) } : a));
}

function parseSavedData(raw) {
  // No key at all = a genuinely new install. Empty, but not a fault.
  if (raw === null || raw === undefined || raw === '') {
    return { ok: true, empty: true, data: { decks: [], cards: [], log: {}, assignments: [], gamification: null, pomodoros: {} } };
  }

  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'unreadable' }; }

  // Deliberately no `data` on any failure path: a caller cannot accidentally
  // treat a failed read as an empty library, because there is nothing to treat.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'wrong-shape' };
  }
  if (!Array.isArray(parsed.decks) || !Array.isArray(parsed.cards)) {
    return { ok: false, reason: 'wrong-shape' };
  }

  return {
    ok: true,
    data: {
      decks: parsed.decks,
      cards: parsed.cards,
      log: (parsed.log && typeof parsed.log === 'object') ? parsed.log : {},
      // `assignments` (feature #27) was added last and must NEVER make an older save
      // unreadable. Anything that is not an array degrades to [] rather than becoming
      // a `wrong-shape` refusal, because a refusal here arms the #19 write lock
      // against a library that is otherwise perfectly good.
      // Rebuild site 2. normalizeAssignmentsForGcal backfills gcalEventId: null on
      // any assignment saved before #33 — see check E2 in (C) test-gcal.mjs.
      assignments: normalizeAssignmentsForGcal(parsed.assignments),
      // Rebuild site 2 (feature #34).
      pomodoros: normalizePomodoros(parsed.pomodoros),
      // `gamification` (feature #32) is the newest field and follows the same rule as
      // assignments: anything unusable degrades to null and is rebuilt by
      // normalizeGamification in loadData. It must NEVER make an older save
      // `wrong-shape`, because that refusal arms the #19 write lock against a library
      // that is otherwise perfectly fine.
      gamification: (parsed.gamification && typeof parsed.gamification === 'object')
        ? parsed.gamification : null
    }
  };
}

/* Whole days since the last export. `null` means "never, or the stored value is
   not trustworthy" — a future date is junk, not a backup from tomorrow. */
function backupAgeDays(lastBackupAt, now) {
  if (!lastBackupAt) return null;
  const then = Date.parse(lastBackupAt);
  if (Number.isNaN(then)) return null;
  const diff = now - then;
  if (diff < 0) return null;
  return Math.floor(diff / MS_PER_DAY);
}

/* What (if anything) to say about backups on the decks screen. */
function backupStatus(opts) {
  const o = opts || {};
  const decks = o.deckCount || 0;
  const cards = o.cardCount || 0;

  // Never nag someone who has nothing to lose.
  if (decks === 0 && cards === 0) return { show: false, level: 'empty', days: null, text: '' };

  const days = backupAgeDays(o.lastBackupAt, o.now);
  if (days === null) {
    return { show: true, level: 'never', days: null,
             text: 'You have never backed up. One click saves everything.' };
  }
  if (days >= BACKUP_STALE_DAYS) {
    return { show: true, level: 'stale', days,
             text: 'Last backup was ' + days + ' days ago.' };
  }
  return { show: true, level: 'fresh', days,
           text: days === 0 ? 'Last backup: today.'
                            : 'Last backup: ' + days + ' day' + (days === 1 ? '' : 's') + ' ago.' };
}

/* Decide whether a backup file may replace the library — extracted from
   onImportFile for the same reason parseSavedData was extracted from loadData:
   the decision is what matters, and it must be testable without a browser.

   This matters most when moving origins. `localStorage` is scoped per origin, so
   hosting Recall means the decks only cross from file:// to https:// through this
   function. Anything it drops is dropped silently, and the hosted app starting
   empty looks identical to data loss.

   The refusal that isn't obvious: an EMPTY backup. `{decks:[],cards:[]}` is valid
   JSON of the right shape, and import writes with `{force:true}` — which
   deliberately bypasses the #19 write lock. So an empty file was a direct path to
   overwriting a real library with nothing. Importing nothing is never the intent;
   the caller can offer "clear everything" as its own explicit action if it is ever
   wanted. */
function parseBackupFile(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { return { ok: false, reason: 'not-json' }; }

  // Accept both the wrapped export format and a bare { decks, cards, log }.
  const incoming = (parsed && typeof parsed === 'object' && parsed.data) ? parsed.data : parsed;
  if (!incoming || typeof incoming !== 'object' ||
      !Array.isArray(incoming.decks) || !Array.isArray(incoming.cards)) {
    return { ok: false, reason: 'wrong-shape' };
  }

  if (incoming.decks.length === 0 && incoming.cards.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  // Decks and cards pass through WHOLE. That is what carries `artifacts`, and
  // rebuilding them field-by-field is exactly how the Descobrimentos timeline and
  // chart would be lost a second time.
  //
  // No srs backfill here on purpose. loadData() already backfills srs, lang, tag,
  // summary and source on every read, so an imported pre-SRS card is repaired the
  // moment it is read back — and this function stays dependency-free, which is the
  // whole reason the 1B block is worth extracting (see the feature #19 design note).
  return {
    ok: true,
    data: {
      decks: incoming.decks,
      cards: incoming.cards,
      log: (incoming.log && typeof incoming.log === 'object') ? incoming.log : {},
      // Same tolerance as parseSavedData: a backup written before feature #27 has no
      // assignments key and must still import cleanly.
      //
      // The `empty` refusal above is deliberately NOT relaxed for assignments. A
      // library holding only assignments and no decks or cards still counts as empty
      // and is still refused — that is the feature #23 firewall against a truncated
      // export overwriting a real library, and it is enforced identically in
      // exportData(), restorePlan() and the Python backend. Weakening it in one place
      // only would reopen the hole. Pinned by check C16 in (C) test-assignments.mjs.
      // Rebuild site 5. A backup written before #33 has no gcalEventId; a backup
      // written after it carries real ones that MUST survive, or restoring
      // duplicates every event on the next sync. Checks E4 and E6.
      assignments: normalizeAssignmentsForGcal(incoming.assignments),
      // Rebuild site 5 (feature #34). A pre-#34 backup has no pomodoros and must still
      // import; a post-#34 one carries real counts that must survive the restore.
      pomodoros: normalizePomodoros(incoming.pomodoros)
    }
  };
}

/* ── Server sync (feature #24) ────────────────────────────────────
   Decisions made BEFORE anything is sent to the backup server. Pure, so the
   throttle and the safety interlocks can be tested without a browser or a server.

   Why a throttle at all: nine functions call saveData(), including updateCardSrs()
   and logReview() — which fire on every card answered. Without this, a review
   session would POST dozens of times, and the server is append-only, so that is
   dozens of files. */

const SYNC_MIN_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes between automatic backups

/* What the user typed in settings, made safe to fetch. '' means the feature is off
   and the app behaves exactly as it did before there was a server. */
function normalizeServerUrl(raw) {
  const s = String(raw === null || raw === undefined ? '' : raw).trim();
  if (!s) return '';

  const withScheme = s.match(/^([a-z][a-z0-9+.\-]*):\/\//i);
  let url;
  if (withScheme) {
    const scheme = withScheme[1].toLowerCase();
    // The app fetches this address. Anything but http(s) — javascript:, data:,
    // file: — is refused rather than stored.
    if (scheme !== 'http' && scheme !== 'https') return '';
    url = s;
  } else if (/^[a-z][a-z0-9+.\-]*:(?!\d)/i.test(s)) {
    return '';                      // scheme-like and not host:port → refuse
  } else {
    url = 'http://' + s;            // "localhost:8000" is what a person types
  }
  return url.replace(/\/+$/, '');
}

/**
 * What saving the Settings modal should do to the stored server address.
 *
 * The API key and the server address share one modal and one Save button, so emptying
 * the address field must never quietly switch backups off. Returns the action plus a
 * notice the caller shows — 'remove' without a notice is the bug this exists to prevent.
 */
function serverUrlChange(rawInput, storedUrl) {
  const raw = (rawInput || '').trim();
  const url = normalizeServerUrl(raw);

  if (raw && !url) {
    return { action: 'error', url: '', notice: 'That address must start with http:// or https://.' };
  }
  if (url) return { action: 'set', url, notice: '' };
  // Field is empty. Only a REMOVAL is worth announcing — otherwise every key save nags.
  if (storedUrl) {
    return { action: 'remove', url: '', notice: 'Server backups turned off — no address set.' };
  }
  return { action: 'none', url: '', notice: '' };
}

/* Should an automatic backup go out right now? */
function shouldAutoSync(opts) {
  const o = opts || {};
  if (!o.serverUrl) return false;          // feature off
  // Never push a failed read. loadData() hands back an empty library when it
  // cannot parse the save (#19); sending that would poison the backup store with
  // emptiness — the same class of damage, one layer further out.
  if (o.dataReadFailed) return false;
  if (!o.dirty) return false;              // nothing changed, nothing to send

  if (o.lastSyncAt === null || o.lastSyncAt === undefined) return true;
  const last = Number(o.lastSyncAt);
  // Junk or a clock skewed into the future must not wedge backups shut forever.
  if (!Number.isFinite(last) || last > o.now) return true;

  return (o.now - last) >= SYNC_MIN_INTERVAL_MS;
}

/* The quiet line under the decks header, beside the existing backup nudge.
   Same shape as backupStatus() so it can reuse the same component and tone. */
function syncStatus(opts) {
  const o = opts || {};
  // An OFF backup feature is VISIBLE. This used to return show:false, on the reasoning
  // that a feature which is off should not occupy space. That reasoning cost two days:
  // after the file:// → github.io move the stored address was gone (an export carries
  // decks, not settings), so backups were off, nothing was sent, and the app said
  // nothing at all. Invisible-off is indistinguishable from working.
  if (!o.serverUrl) {
    return { show: true, level: 'warn',
             text: 'Server backups are off — no address set in Settings.' };
  }

  if (o.lastError) {
    return { show: true, level: 'warn',
             text: 'Server backup failed: ' + o.lastError + '. Downloading a backup still works.' };
  }

  const last = Number(o.lastSyncAt);
  if (o.lastSyncAt === null || o.lastSyncAt === undefined || !Number.isFinite(last)) {
    return { show: true, level: 'warn', text: 'Not backed up to the server yet.' };
  }

  const days = Math.max(0, Math.floor((o.now - last) / 86400000));
  return { show: true, level: 'quiet',
           text: days === 0 ? 'Server backup: today.'
                            : 'Server backup: ' + days + ' day' + (days === 1 ? '' : 's') + ' ago.' };
}

/* ── Restore (feature #25) ────────────────────────────────────────
   Restore is the most dangerous button in the app: it ends in
   saveData(force:true), the one call that deliberately bypasses the #19 write
   lock. Everything that DECIDES lives here, pure and tested. */

/* Newest first. Backup filenames are timestamped and zero-padded on the server
   precisely so that sorting them as text sorts them by time; this relies on that.
   A list in the wrong order is how someone restores three-week-old data by
   accident, so it is locked in by a test. */
function sortBackupsNewestFirst(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(e => e && typeof e === 'object' && typeof e.name === 'string' && e.name)
    .slice()
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

/* One row in the restore list. The filename is not a description — "3 decks · 25
   cards" tells you whether it is worth restoring, and the filename does not. */
function describeBackup(entry, now) {
  const e = entry || {};
  const when = Date.parse(e.savedAt);
  let title;
  if (!Number.isFinite(when)) {
    title = 'Unknown date';
  } else {
    const d = new Date(when);
    const time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const sameDay = Number.isFinite(now) && new Date(now).toDateString() === d.toDateString();
    title = sameDay ? 'Today, ' + time
                    : d.getDate() + ' ' + d.toLocaleString('en-GB', { month: 'long' }) + ', ' + time;
  }
  return {
    title,
    detail: plural(Number(e.decks) || 0, 'deck') + ' · ' + plural(Number(e.cards) || 0, 'card')
  };
}

/* May this backup replace the library, and what exactly is the user agreeing to?
   The warning text is safety-critical, not cosmetic: a dialog that misreports the
   numbers is worse than no dialog, because it buys false confidence at the exact
   moment someone is about to lose work. */
function restorePlan(opts) {
  const o = opts || {};
  const incoming = o.incoming;
  const current = o.current || { decks: [], cards: [] };

  if (!incoming || typeof incoming !== 'object' ||
      !Array.isArray(incoming.decks) || !Array.isArray(incoming.cards)) {
    return { ok: false, reason: 'wrong-shape' };
  }
  // Same refusal as parseBackupFile and the server. Restoring nothing over a real
  // library is precisely the 2026-07-26 failure.
  if (incoming.decks.length === 0 && incoming.cards.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const counts = {
    current: {
      decks: (current.decks || []).length,
      cards: (current.cards || []).length,
      assignments: (current.assignments || []).length
    },
    incoming: {
      decks: incoming.decks.length,
      cards: incoming.cards.length,
      assignments: (incoming.assignments || []).length
    }
  };

  /* Assignments (feature #27) are named ONLY when either side has some.
     With none on either side the sentence stays byte-identical to the one that
     shipped and was reviewed before #27 — "and 0 assignments" is noise in a dialog
     whose entire value is that it gets read, and everyone who does not use the
     feature would pay for it. When either side is non-zero the number appears, and
     that covers the only case where a restore can lose an assignment. Pinned by
     checks R43 and R44 in (C) test-assignments.mjs. */
  const showAsg = counts.current.assignments > 0 || counts.incoming.assignments > 0;
  const tail = (c) => showAsg
    ? plural(c.decks, 'deck') + ', ' + plural(c.cards, 'card') + ' and ' +
      plural(c.assignments, 'assignment')
    : plural(c.decks, 'deck') + ' and ' + plural(c.cards, 'card');

  const nothingHere = counts.current.decks === 0 && counts.current.cards === 0 &&
                      counts.current.assignments === 0;
  const have = nothingHere
    ? 'You have nothing saved here right now.'
    : 'You have ' + tail(counts.current) + ' right now.';

  return {
    ok: true,
    counts,
    warning: have + ' This backup has ' + tail(counts.incoming) +
             '. Your current decks are copied to the ' +
             'server first, so this can be undone.'
  };
}

/* ── 1B-impure ───────────────────────────────────────────────────
   The write lock. Every destructive path in the app funnels through
   saveData(), so this single guard closes all of them at once. */

const BACKUP_AT_KEY = 'recall.lastBackup';

let dataReadFailed = false;
let dataReadFailReason = '';

function lastBackupAt() { return localStorage.getItem(BACKUP_AT_KEY); }

/* One line under the decks header: either a warning that the save is unreadable,
   or how long it has been since a backup. Never a modal — a nag you have to
   dismiss is a nag you learn to dismiss without reading. */
function renderBackupNudge() {
  const el = document.getElementById('backup-nudge');
  if (!el) return;

  if (dataReadFailed) {
    el.className = 'backup-nudge danger';
    el.style.display = '';
    el.innerHTML =
      `<div><strong>Your saved data could not be read.</strong> Nothing has been changed or deleted.
       Do not create decks or cards — that would overwrite it. Download the raw data first,
       then import a backup.</div>
       <button class="btn btn-outline btn-sm" onclick="downloadRawData()">Download raw data</button>`;
    return;
  }

  const data = loadData();
  const s = backupStatus({
    lastBackupAt: lastBackupAt(), now: Date.now(),
    deckCount: data.decks.length, cardCount: data.cards.length
  });

  // Feature #24: the server line shares this slot rather than adding a new one.
  // Same component, same tone — no new visual language for a second backup.
  const sync = syncStatus({
    serverUrl: getServerUrl(), lastSyncAt: lastSyncAt(),
    now: Date.now(), lastError: lastSyncError
  });

  if (!s.show && !sync.show) { el.style.display = 'none'; return; }
  el.style.display = '';
  const anyWarning = (s.show && s.level !== 'fresh') || (sync.show && sync.level === 'warn');
  el.className = 'backup-nudge' + (anyWarning ? ' warn' : ' quiet');

  let html = '';
  if (s.show) {
    html += `<div>${escapeHtml(s.text)}</div>` + (s.level === 'fresh' ? ''
      : `<button class="btn btn-outline btn-sm" onclick="exportData()">Back up now</button>`);
  }
  if (sync.show) {
    html += `<div>${escapeHtml(sync.text)}</div>`
          + `<button class="btn btn-outline btn-sm" onclick="onBackupToServer()">Back up to server</button>`
          + `<button class="btn btn-outline btn-sm" onclick="openRestoreModal()">Restore</button>`;
  }
  el.innerHTML = html;
}

function loadData() {
  const result = parseSavedData(localStorage.getItem(STORAGE_KEY));

  if (!result.ok) {
    // Arm the lock. We still hand back an empty library so the UI can render,
    // but saveData() will now refuse to write it over the real bytes.
    dataReadFailed = true;
    dataReadFailReason = result.reason;
    console.error('Recall could not read your saved data (' + result.reason +
                  '). Nothing has been changed. Writing is blocked until this is resolved.');
    return { decks: [], cards: [], log: {}, assignments: [], gamification: emptyGamification(), pomodoros: {} };
  }

  dataReadFailed = false;
  dataReadFailReason = '';

  {
    const parsed = result.data;
    // Backfill tag, summary and source on any deck that predates those fields.
    // `artifacts` (keyed by kind: table, sheet, …) replaced the single-slot
    // `artifact` field — migrate old saves losslessly and drop the old field.
    const decks = (parsed.decks || []).map(d => {
      const { artifact, ...rest } = d;
      const artifacts = (d.artifacts && typeof d.artifacts === 'object') ? d.artifacts
        : (artifact && typeof artifact === 'object' && artifact.type) ? { [artifact.type]: artifact }
        : {};
      return {
        ...rest,
        tag: d.tag === undefined ? '' : d.tag,
        summary: d.summary === undefined ? '' : d.summary,
        source: d.source === undefined ? '' : d.source,
        // `lang` (the read-aloud voice language) arrived with feature #18.
        // Decks saved before it get SPEECH_DEFAULT_LANG, which became en-US on
        // 2026-07-26 when all decks went English. Same backfill idea as above.
        lang: normalizeLang(d.lang),
        artifacts
      };
    });
    // Backfill srs on any card that predates spaced repetition.
    const cards = (parsed.cards || []).map(c => c.srs ? c : { ...c, srs: newSrs() });
    // `log` (the daily study history) was added later — default it for old saves.
    const log = parsed.log || {};
    // Already normalized by parseSavedData; taken straight through, NOT re-derived.
    // This return is the trap: parseSavedData hands back a clean object and this
    // function reassembles it from scratch, so it reads like a pass-through and is
    // not. Fixing parseSavedData alone still loses every assignment, one line later.
    // Rebuild site 4. For gcalEventId this really IS a pass-through, unlike the #27
    // case the comment above describes: `parsed` is parseSavedData's output, which
    // already normalized the field, so re-normalizing here changes nothing.
    //
    // That is not an assumption — it was MEASURED. (C) mutate-gcal.mjs replaced this
    // line with the bare `parsed.assignments` and the entire suite stayed green, which
    // means a normalize call here would be code no test can prove. It was removed
    // rather than left as decoration. If a future field is normalized ONLY in
    // loadData's caller and not in parseSavedData, this line becomes load-bearing
    // again — and the mutation will start failing, which is the signal to change it.
    const assignments = parsed.assignments;
    // Same trap the comment above describes: this return rebuilds the object from
    // scratch, so a field missing HERE is lost even when parseSavedData carried it.
    const gamification = normalizeGamification(parsed.gamification);
    // Rebuild site 4 (feature #34) — THE TRAP. This return names its keys explicitly,
    // so a key omitted HERE is lost on every reload even though parseSavedData carried
    // it correctly. That is the #27 assignments bug verbatim. Pinned by check E2.
    const pomodoros = normalizePomodoros(parsed.pomodoros);
    return { decks, cards, log, assignments, gamification, pomodoros };
  }
}

/* Writes the library — unless the last read failed, in which case it refuses.
   Returns true if it wrote.

   `{ force: true }` is the deliberate escape hatch, used only by backup import:
   that is the user explicitly saying "replace everything". Without it, corrupt
   data would be unrecoverable from inside the app, because the guard would also
   block the one action that fixes it. */
function saveData(data, opts) {
  if (dataReadFailed && !(opts && opts.force)) {
    console.error('Refusing to save: your existing data could not be read (' + dataReadFailReason +
                  '). Saving now would overwrite it. Download the raw data, then import a backup.');
    return false;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  dataReadFailed = false;      // whatever was wrong, this write resolved it
  dataReadFailReason = '';

  // Feature #24. Every path that changes data funnels through here — nine callers,
  // per the graph — so one hook covers all of them, exactly as the write lock above
  // does. Deliberately not awaited: a backup must never delay or block a save.
  syncDirty = true;
  maybeAutoSync();

  return true;
}

/* ── Server sync, impure half (feature #24) ───────────────────────
   The decisions live in the 1B pure block (normalizeServerUrl, shouldAutoSync,
   syncStatus). This part does the talking. */

const SERVER_URL_KEY = 'recall.serverUrl';
const LAST_SYNC_KEY  = 'recall.lastSync';

// Own keys, not inside recall.data — same reasoning as recall.lastBackup: these
// describe this browser's setup, not your library, and must survive the import
// that replaces recall.data wholesale.
let syncDirty = false;
let syncInFlight = false;
let lastSyncError = '';

function getServerUrl() { return normalizeServerUrl(localStorage.getItem(SERVER_URL_KEY)); }
function lastSyncAt() {
  const v = Number(localStorage.getItem(LAST_SYNC_KEY));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/* Send the library to the server. Returns true if it landed.
   `quiet` is what separates automatic from manual: an automatic backup that cannot
   reach the server must not interrupt studying, but a button you pressed must
   always tell you what happened (#22 — no dead ends). */
async function syncToServer(opts) {
  const quiet = !!(opts && opts.quiet);
  const url = getServerUrl();
  if (!url) { if (!quiet) toast('No backup server set — add one in settings'); return false; }
  if (syncInFlight) return false;

  // Never push a failed read: loadData() hands back an empty library when it cannot
  // parse the save (#19), and the server would be storing that emptiness.
  if (dataReadFailed) {
    if (!quiet) toast('Not backing up — your saved data could not be read');
    return false;
  }

  syncInFlight = true;
  try {
    const payload = { app: 'recall', version: 1, exportedAt: new Date().toISOString(), data: loadData() };
    const res = await fetch(url + '/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      // The server refuses empty and malformed backups on purpose. Say which.
      let reason = '';
      try { reason = (await res.json()).reason || ''; } catch (e) { /* no body */ }
      throw new Error(reason === 'empty' ? 'there is nothing to back up yet' : (reason || ('HTTP ' + res.status)));
    }

    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    syncDirty = false;
    lastSyncError = '';
    if (!quiet) toast('Backed up to server');
    return true;
  } catch (e) {
    lastSyncError = e.message === 'Failed to fetch' ? 'server not reachable' : e.message;
    if (!quiet) toast('Server backup failed: ' + lastSyncError);
    return false;
  } finally {
    syncInFlight = false;
    renderBackupNudge();
  }
}

/* Called after every save. The throttle lives in shouldAutoSync so it is testable. */
function maybeAutoSync() {
  const go = shouldAutoSync({
    serverUrl: getServerUrl(), dirty: syncDirty, lastSyncAt: lastSyncAt(),
    now: Date.now(), dataReadFailed
  });
  if (go) syncToServer({ quiet: true });
}

function onBackupToServer() { syncToServer({ quiet: false }); }

/* ── Restore, impure half (feature #25) ───────────────────────────
   Three layers, because this ends in saveData(force:true) — the one call that
   deliberately bypasses the #19 write lock. */

let restorePick = '';

function closeRestoreModal() { document.getElementById('restore-modal').classList.remove('open'); }

async function openRestoreModal() {
  const url = getServerUrl();
  if (!url) { toast('No backup server set — add one in settings'); return; }

  restorePick = '';
  const list = document.getElementById('restore-list');
  const err = document.getElementById('restore-error');
  const confirmBtn = document.getElementById('restore-confirm');
  confirmBtn.disabled = true;
  err.textContent = '';
  list.innerHTML = '<div class="restore-empty">Loading…</div>';
  document.getElementById('restore-modal').classList.add('open');

  let entries;
  try {
    const res = await fetch(url + '/backups');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    entries = sortBackupsNewestFirst(await res.json());
  } catch (e) {
    // Never a dead end (#22): say what happened, offer the way out that always works.
    list.innerHTML = '<div class="restore-empty">Could not reach the backup server.</div>';
    err.innerHTML = 'Is it running? '
      + '<button class="btn btn-outline btn-sm" onclick="openRestoreModal()">Try again</button> '
      + '<button class="btn btn-outline btn-sm" onclick="closeRestoreModal();importData()">Import a file instead</button>';
    return;
  }

  if (entries.length === 0) {
    list.innerHTML = '<div class="restore-empty">No backups on the server yet.</div>';
    err.innerHTML = '<button class="btn btn-outline btn-sm" onclick="closeRestoreModal();onBackupToServer()">Back up to server</button>';
    return;
  }

  const now = Date.now();
  list.innerHTML = entries.map(e => {
    const d = describeBackup(e, now);
    return `<button type="button" class="restore-row" role="radio" aria-checked="false"
              data-name="${escapeHtml(e.name)}" onclick="onPickBackup(this)">
              <span class="rr-title">${escapeHtml(d.title)}</span>
              <span class="rr-detail">${escapeHtml(d.detail)}</span>
            </button>`;
  }).join('');
}

function onPickBackup(el) {
  document.querySelectorAll('#restore-list .restore-row')
    .forEach(r => r.setAttribute('aria-checked', String(r === el)));
  restorePick = el.getAttribute('data-name') || '';
  document.getElementById('restore-confirm').disabled = !restorePick;
}

async function onRestoreSelected() {
  if (!restorePick) return;
  const url = getServerUrl();
  const err = document.getElementById('restore-error');
  err.textContent = '';

  // LAYER 1 — back up what is here first. The server is append-only, so this costs
  // one file and makes a mistaken restore reversible: what you are about to replace
  // ends up one row above the row you picked. If it fails, there is no safety net,
  // so the restore does not proceed.
  const safe = await syncToServer({ quiet: true });
  if (!safe) {
    err.textContent = 'Could not back up your current decks first, so nothing was changed. '
                    + (lastSyncError || '');
    return;
  }

  let payload;
  try {
    const res = await fetch(url + '/backups/' + encodeURIComponent(restorePick));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    payload = await res.text();
  } catch (e) {
    err.textContent = 'Could not download that backup. Nothing was changed.';
    return;
  }

  // LAYER 2 — the same door a file import goes through. One validation path, not two.
  const parsed = parseBackupFile(payload);
  if (!parsed.ok) {
    err.textContent = parsed.reason === 'empty'
      ? 'That backup is empty — restoring it would erase everything. Nothing was changed.'
      : 'That backup could not be read. Nothing was changed.';
    return;
  }

  // LAYER 3 — a confirmation that states the loss in numbers, not "are you sure?".
  const plan = restorePlan({ incoming: parsed.data, current: loadData() });
  if (!plan.ok) { err.textContent = 'That backup cannot be restored. Nothing was changed.'; return; }
  if (!confirm('Replace everything with this backup?\n\n' + plan.warning)) return;

  saveData(parsed.data, { force: true });
  closeRestoreModal();
  toast('Restored ' + plan.counts.incoming.decks + ' deck' + (plan.counts.incoming.decks === 1 ? '' : 's'));
  goDecks();
}

function newId(prefix) {
  const rand = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2);
  return prefix + '_' + rand;
}

function createDeck(name, tag, lang) {
  const data = loadData();
  const deck = {
    id: newId('deck'), name, tag: tag || '', createdAt: Date.now(),
    summary: '', source: '', lang: normalizeLang(lang), artifacts: {}
  };
  saveData({ ...data, decks: [...data.decks, deck] });
  return deck;
}

/* Change which language a deck is read aloud in. */
function updateDeckLang(deckId, lang) {
  const data = loadData();
  const decks = data.decks.map(d => d.id === deckId ? { ...d, lang: normalizeLang(lang) } : d);
  saveData({ ...data, decks });
}

/* Set a deck's AI summary (regenerating replaces it — newest material wins). */
function updateDeckSummary(deckId, summary) {
  const data = loadData();
  const decks = data.decks.map(d => d.id === deckId ? { ...d, summary } : d);
  saveData({ ...data, decks });
}

/* Keep the raw text a deck's cards were generated from, so Chat can answer
   questions about it later. Same rule as the summary: regenerating replaces it. */
function updateDeckSource(deckId, source) {
  const data = loadData();
  const decks = data.decks.map(d => d.id === deckId ? { ...d, source } : d);
  saveData({ ...data, decks });
}

/* Save one kind of study artifact onto a deck (artifacts is keyed by kind:
   table, sheet, …). One slot per kind — regenerating that kind replaces it. */
function updateDeckArtifact(deckId, type, artifact) {
  const data = loadData();
  const decks = data.decks.map(d => d.id === deckId ? { ...d, artifacts: { ...d.artifacts, [type]: artifact } } : d);
  saveData({ ...data, decks });
}

function deleteDeck(deckId) {
  const data = loadData();
  // Spread ...data so the study log (and any future fields) survive the delete.
  saveData({
    ...data,
    decks: data.decks.filter(d => d.id !== deckId),
    cards: data.cards.filter(c => c.deckId !== deckId)
  });
  // Drop the in-memory chat thread too (feature #29). Ids are unique, so this is
  // belt-and-braces rather than a live bug — but a deleted deck leaving its
  // conversation behind is exactly the kind of thing that becomes one later.
  chatHistoryStore = forgetChat(chatHistoryStore, deckId);
}

function addCard(deckId, front, back) {
  const data = loadData();
  const card = { id: newId('card'), deckId, front, back, createdAt: Date.now(), srs: newSrs() };
  saveData({ ...data, cards: [...data.cards, card] });
  return card;
}

function deleteCard(cardId) {
  const data = loadData();
  saveData({ ...data, cards: data.cards.filter(c => c.id !== cardId) });
}

/* Edit a card's text only — keep its id, srs schedule, and createdAt. */
function updateCard(cardId, front, back) {
  const data = loadData();
  const cards = data.cards.map(c => c.id === cardId ? { ...c, front, back } : c);
  saveData({ ...data, cards });
}

/* Replace a card's srs (used by the scheduler) — new object, then save. */
function updateCardSrs(cardId, srs) {
  const data = loadData();
  const cards = data.cards.map(c => c.id === cardId ? { ...c, srs } : c);
  saveData({ ...data, cards });
}

/* Study log: one integer per calendar day = how many cards you reviewed.
   `srs` only remembers each card's LAST review, so it can't tell us which
   days you studied. This log can — it's what streaks and the calendar read. */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function logReview(n = 1) {
  const data = loadData();
  const key = dayKey(Date.now());
  const log = { ...data.log, [key]: (data.log[key] || 0) + n };  // immutable bump
  saveData({ ...data, log });
}

function getDeck(deckId) { return loadData().decks.find(d => d.id === deckId) || null; }
function getCard(cardId) { return loadData().cards.find(c => c.id === cardId) || null; }

function cardsForDeck(deckId) {
  return loadData().cards
    .filter(c => c.deckId === deckId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function dueCards(deckId) {
  const now = Date.now();
  return cardsForDeck(deckId).filter(c => (c.srs?.due ?? 0) <= now);
}
function dueCount(deckId) { return dueCards(deckId).length; }

/* ── PURE assignments ────────────────────────────────────────────
   1E. ASSIGNMENTS — school tasks (feature #27), pure half.

   Everything here is a plain function of its arguments: no localStorage, no DOM,
   no clock of its own. `now` is always passed in, so "is this overdue" is testable
   without waiting for tomorrow.

   THIS BLOCK MUST NOT REFERENCE ANYTHING OUTSIDE ITSELF. (C) test-assignments.mjs
   lifts it out with new Function() and evaluates it standalone; naming an outside
   identifier (dayKey, MS_PER_DAY, DAY) throws a ReferenceError that takes the whole
   slice down and fakes a failure for every check in the suite. Hence the local
   day constant below rather than reusing one from section 1A.
   ---------------------------------------------------------------- */

const ASSIGNMENT_PRIORITIES = ['high', 'med', 'low'];
const PRIORITY_RANK = { high: 0, med: 1, low: 2 };
/* An unrecognised priority sorts after every known one instead of crashing the
   screen. Bad data should degrade the ordering, never the render. */
const PRIORITY_RANK_UNKNOWN = ASSIGNMENT_PRIORITIES.length;

/* Midnight local time on the day `ts` falls in. Local, not UTC: a due date is a
   calendar day the way a person means it, not an instant. */
function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function priorityRank(priority) {
  return priority in PRIORITY_RANK ? PRIORITY_RANK[priority] : PRIORITY_RANK_UNKNOWN;
}

/* Coerce anything the UI (or an imported backup) hands over into a well-formed
   assignment body. Kept separate from createAssignment so the validation is
   testable without a browser — the same split as parseSavedData/loadData. */
function normalizeAssignment(fields, now) {
  const f = fields || {};
  const dueAt = Number(f.dueAt);
  return {
    title: String(f.title == null ? '' : f.title).trim(),
    subject: String(f.subject == null ? '' : f.subject).trim(),
    // 0 means "no due date". Anything unparseable becomes 0 rather than NaN,
    // which would poison every comparison it touches.
    dueAt: Number.isFinite(dueAt) && dueAt > 0 ? dueAt : 0,
    priority: ASSIGNMENT_PRIORITIES.includes(f.priority) ? f.priority : 'med',
    deckId: String(f.deckId == null ? '' : f.deckId),
    done: f.done === true,
    createdAt: Number.isFinite(Number(f.createdAt)) && Number(f.createdAt) > 0
      ? Number(f.createdAt) : now,
    // Declared explicitly rather than left to survive by accident. The old shape
    // relied on updateAssignment spreading `a` FIRST to preserve unknown keys, while
    // createAssignment dropped them — so the field lived or died depending on which
    // path touched it. Naming it here makes both paths agree, and makes a later
    // "tidy-up" of updateAssignment unable to silently drop it.
    //
    // Inlined, NOT a call to normalizeGcalEventId(): this block is lifted out and
    // evaluated standalone by (C) test-assignments.mjs, and naming an identifier from
    // the gcal block throws a ReferenceError that takes the whole slice down and fakes
    // a failure for all 48 of its checks. The duplication is deliberate and cheap.
    gcalEventId: typeof f.gcalEventId === 'string' && f.gcalEventId ? f.gcalEventId : null
  };
}

/* Overdue needs BOTH terms: a deadline that has passed, and work not yet done.
   The comparison is against the start of today, not against `now` — dueAt is a
   day, so `dueAt < now` would mark everything due today as overdue from 00:01. */
function isOverdue(a, now) {
  if (!a || a.done === true) return false;
  if (!a.dueAt) return false;              // 0 = no deadline, can never be late
  return a.dueAt < startOfDay(now);
}

function overdueAssignments(list, now) {
  return (list || []).filter(a => isOverdue(a, now));
}

/* Undated assignments sort LAST in due order. A naive ascending sort puts dueAt 0
   first, so "no deadline" would render as the most urgent thing on the screen. */
function dueOrder(a, b) {
  const ax = a.dueAt || Infinity;
  const bx = b.dueAt || Infinity;
  if (ax !== bx) return ax - bx;
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  return (a.createdAt || 0) - (b.createdAt || 0);   // last resort, so order is stable
}

function priorityOrder(a, b) {
  const pr = priorityRank(a.priority) - priorityRank(b.priority);
  if (pr !== 0) return pr;
  return (a.dueAt || Infinity) - (b.dueAt || Infinity);
}

/* Spread before sorting: Array.prototype.sort is in-place, and the array being
   sorted is the one loadData() handed out. */
function sortAssignments(list, mode) {
  return [...(list || [])].sort(mode === 'priority' ? priorityOrder : dueOrder);
}

/* Completed assignments drop out of the active list but are NEVER removed from the
   library — a "done" flag that erases the record is a destructive default wearing a
   harmless label. `showCompleted` brings them back. */
function filterAssignments(list, opts) {
  const o = opts || {};
  const subject = String(o.subject || '').trim().toLowerCase();
  return (list || []).filter(a => {
    if (!o.showCompleted && a.done) return false;
    // Case-insensitive, the same comparison filterDecks already makes on tags.
    if (subject && String(a.subject || '').toLowerCase() !== subject) return false;
    return true;
  });
}
/* ── END PURE assignments */

/* ── PURE gcal ───────────────────────────────────────────────────
   1G. GOOGLE CALENDAR SYNC (feature #33), pure half.

   Everything here is a plain function of its arguments: no network, no DOM, no
   token, no Google. Steps 1 and 4 of the sync (list, execute) are the only impure
   parts and they are thin; every interesting bug lives in the diff below.

   THIS BLOCK MUST NOT REFERENCE ANYTHING OUTSIDE ITSELF. (C) test-gcal.mjs lifts it
   out with new Function() and evaluates it standalone; naming an outside identifier
   (startOfDay, ASSIGNMENT_PRIORITIES) throws a ReferenceError that takes the whole
   slice down and fakes a failure for every check in the suite.

   It also sits BEFORE the SM-2 marker on purpose: the storage harness in
   (C) test-gcal.mjs slices app.js at that marker, and the read paths call
   normalizeAssignmentsForGcal(). Move this block below the marker and every
   rebuild-site check dies with a ReferenceError instead of a real result.
   ---------------------------------------------------------------- */

/* Google's own palette ids. Named because "11" at a call site is unreadable. */
const GCAL_COLOR_HIGH = '11';   // Tomato
const GCAL_COLOR_MED  = '6';    // Tangerine
const GCAL_COLOR_LOW  = '8';    // Graphite
const GCAL_COLOR_DONE = '8';    // Graphite — done outranks priority

/* The private marker every Recall event carries. events.list filters on it, which
   is what makes the delete path safe: without the filter the diff would see Diogo's
   personal events as orphans and propose deleting them. */
const GCAL_MARKER_KEY = 'recallAssignment';

/* A CONSTANT marker, and the reason the per-assignment one above is not enough.

   Google's `privateExtendedProperty` filter matches an exact key=value pair and does
   NOT wildcard, so there is no query for "every event carrying a recallAssignment key".
   Filtering on `recallAssignment=<id>` would need one request per assignment, and
   filtering on nothing would return Diogo's ENTIRE personal calendar — which the diff
   would then propose deleting.

   So every Recall event also carries recallApp=1, a value that never varies, and the
   list is scoped with `privateExtendedProperty=recallApp=1`. Pinned by check B13. */
const GCAL_APP_KEY = 'recallApp';
const GCAL_APP_VALUE = '1';

function gcalPad2(n) { return String(n).padStart(2, '0'); }

/* "YYYY-MM-DD" from LOCAL date parts.

   NEVER new Date(ts).toISOString().slice(0,10). toISOString converts to UTC, and at
   UTC+1 an assignment due at 00:00 on the 15th becomes 2026-09-14T23:00Z — a deadline
   shown a day EARLY, the one error a deadline tool must not make. Checks A1 and A3
   use midnight timestamps precisely so that mistake cannot pass. */
function gcalDateString(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + gcalPad2(d.getMonth() + 1) + '-' + gcalPad2(d.getDate());
}

/* Google's all-day end.date is EXCLUSIVE: a one-day event must end on the following
   day or it renders as zero-length. Built by stepping a local Date rather than by
   arithmetic on the string, so month, year and leap-day rollovers are the calendar's
   problem and not ours. */
function gcalNextDayString(dateStr) {
  const p = String(dateStr).split('-');
  const d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  d.setDate(d.getDate() + 1);
  return gcalDateString(d.getTime());
}

function calculateGCalDates(dueAt) {
  const start = gcalDateString(dueAt);
  return { start: { date: start }, end: { date: gcalNextDayString(start) } };
}

/* Subject goes in the TITLE, not the description: Google's month view renders only
   the title, and a subject hidden in the description does not serve "see everything
   at a glance". An assignment with no subject gets the bare title — no dangling em
   dash, which is what check B2 exists to stop. */
function gcalEventTitle(a) {
  const subject = String((a && a.subject) || '').trim();
  const title = String((a && a.title) || '').trim();
  const base = subject ? subject + ' — ' + title : title;
  return a && a.done === true ? '✓ ' + base : base;
}

function gcalEventColorId(a) {
  if (!a || a.done === true) return GCAL_COLOR_DONE;
  if (a.priority === 'high') return GCAL_COLOR_HIGH;
  if (a.priority === 'med') return GCAL_COLOR_MED;
  // low AND anything unrecognised. Bad data should degrade the colour, never the sync.
  return GCAL_COLOR_LOW;
}

function gcalPriorityLabel(a) {
  const p = a && a.priority;
  if (p === 'high') return 'alta';
  if (p === 'low') return 'baixa';
  return 'média';
}

function gcalEventDescription(a) {
  return 'Prioridade: ' + gcalPriorityLabel(a) + '\nCriado no Recall';
}

function buildGCalEvent(a) {
  const dates = calculateGCalDates(a && a.dueAt);
  return {
    summary: gcalEventTitle(a),
    description: gcalEventDescription(a),
    start: dates.start,
    end: dates.end,
    colorId: gcalEventColorId(a),
    // Notification timing was explicitly NOT designed. The calendar's own default
    // is a decision the user already made once, everywhere.
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        // Constant — what events.list filters on.
        [GCAL_APP_KEY]: GCAL_APP_VALUE,
        // Per-assignment — not used for matching (gcalEventId does that), but it keeps
        // the link recoverable if a library is ever restored without its event ids.
        [GCAL_MARKER_KEY]: String(a && a.id)
      }
    }
  };
}

/* Compares only the fields Recall OWNS. Google's etag, updated, htmlLink and every
   field we never set are ignored, so a second sync with no local change performs
   zero writes and reports "Nada a fazer". */
function gcalEventMatches(desired, remoteEvent) {
  if (!desired || !remoteEvent) return false;
  const r = remoteEvent;
  return String(r.summary || '') === String(desired.summary || '')
    && String(r.description || '') === String(desired.description || '')
    && String((r.start && r.start.date) || '') === desired.start.date
    && String((r.end && r.end.date) || '') === desired.end.date
    && String(r.colorId || '') === String(desired.colorId || '');
}

/* Step 3 of the sync: two arrays in, four arrays out.

   `remoteEvents` must ONLY contain events Recall created — the caller scopes the
   list by GCAL_MARKER_KEY. Everything not claimed by a local assignment is proposed
   for deletion, so widening that query widens what gets deleted. */
function diffCalendarEvents(localAssignments, remoteEvents) {
  const locals = Array.isArray(localAssignments) ? localAssignments : [];
  const remotes = Array.isArray(remoteEvents) ? remoteEvents : [];

  const byId = new Map();
  for (const e of remotes) if (e && e.id != null) byId.set(String(e.id), e);

  const toCreate = [], toUpdate = [], toDelete = [], skipped = [];
  const claimed = new Set();

  for (const a of locals) {
    if (!a) continue;
    const eventId = typeof a.gcalEventId === 'string' && a.gcalEventId ? a.gcalEventId : null;
    const existing = eventId ? byId.get(eventId) : undefined;
    if (existing) claimed.add(eventId);

    // dueAt 0 means "no deadline". There is nowhere to put it on a calendar, so it
    // is reported as skipped rather than dropped in silence — items vanishing
    // quietly is the failure shape this project has now been bitten by four times.
    if (!(Number(a.dueAt) > 0)) {
      if (existing) toDelete.push({ eventId, assignmentId: a.id });
      skipped.push(a);
      continue;
    }

    const desired = buildGCalEvent(a);
    // A gcalEventId pointing at nothing means the event was deleted by hand in
    // Google. Recreating it is deliberate: deletion there is self-healing, not
    // sticky. The only way to remove one permanently is to remove the assignment.
    if (!existing) { toCreate.push({ assignment: a, event: desired }); continue; }
    if (!gcalEventMatches(desired, existing)) {
      toUpdate.push({ eventId, assignment: a, event: desired });
    }
  }

  for (const e of remotes) {
    const id = String(e && e.id != null ? e.id : '');
    if (id && !claimed.has(id)) toDelete.push({ eventId: id, assignmentId: null });
  }

  return { toCreate, toUpdate, toDelete, skipped };
}

function gcalCountPhrase(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/* A feature that did nothing must SAY it did nothing — the rule earned on
   2026-07-30, when an off backup feature reported success by staying silent. */
function summarizeGCalSync(counts) {
  const c = counts || {};
  const parts = [];
  if (c.created) parts.push(gcalCountPhrase(c.created, 'criado', 'criados'));
  if (c.updated) parts.push(gcalCountPhrase(c.updated, 'movido', 'movidos'));
  if (c.deleted) parts.push(gcalCountPhrase(c.deleted, 'removido', 'removidos'));
  if (c.skipped) parts.push(c.skipped + ' sem prazo');
  return parts.length ? parts.join(' · ') : 'Nada a fazer';
}

/* normalizeGcalEventId and normalizeAssignmentsForGcal are NOT defined here.

   They live in the 1B pure block instead, next to parseSavedData. (C) test-backup.mjs
   and (C) test-migration.mjs slice app.js from `const BACKUP_STALE_DAYS` to
   `/* ── 1B-impure`, so a read path calling a helper defined down here fails with
   "normalizeAssignmentsForGcal is not defined" across both suites — which is exactly
   what happened while building this feature. The helper must sit at or above the
   highest slice that calls it. */
/* ── END PURE gcal */

/* ── 1G-impure. GOOGLE CALENDAR SYNC — the thin outside half ─────
   Steps 1 and 4 of the sync (list, execute). Everything decidable lives in the pure
   block above; this part only moves bytes.

   WHY THE TOKEN IS NOT IN localStorage. The spec asked for access_token and
   refresh_token in localStorage. Google does not issue a refresh token to a browser
   client with no secret — there is nothing durable to store. What is left is a ~1h
   bearer token, and putting that in localStorage buys under an hour of convenience in
   exchange for making it readable by any XSS, on an origin that already holds the
   Anthropic key. So it lives in a module variable and dies with the tab.

   WHY THE SYNC IS MANUAL. That same expiry has no silent renewal. An automatic sync
   would work for an hour and then quietly stop — precisely the failure that left the
   backup server off for two days in July with zero POSTs and zero warnings. A button
   means the token is requested while Diogo is looking at the screen.
   ---------------------------------------------------------------- */

const GCAL_CLIENT_ID_KEY = 'recall.gcalClientId';
const GCAL_LAST_SYNC_KEY = 'recall.gcalLastSyncAt';
const GCAL_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const GCAL_GIS_SRC = 'https://accounts.google.com/gsi/client';
const GCAL_API_BASE = 'https://www.googleapis.com/calendar/v3';

let gcalAccessToken = null;      // memory only, dies with the tab — see above
let gcalScriptPromise = null;

function getGCalClientId() { return localStorage.getItem(GCAL_CLIENT_ID_KEY) || ''; }
function isGCalConfigured() { return !!getGCalClientId(); }
function isGCalConnected() { return !!gcalAccessToken; }

function gcalLastSyncAt() {
  const v = Number(localStorage.getItem(GCAL_LAST_SYNC_KEY));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/* Google's library, fetched ONLY when Connect is pressed.

   Never at startup and never precached: sw.js must not cache it, or an offline launch
   would stall on a request that cannot succeed. Syncing needs the network anyway, so
   loading it lazily costs nothing and keeps the offline guarantee (#26) intact. */
function loadGisScript() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) {
    return Promise.resolve();
  }
  if (gcalScriptPromise) return gcalScriptPromise;
  gcalScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = GCAL_GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      // Cleared so a later retry actually retries instead of reusing the rejection.
      gcalScriptPromise = null;
      reject(new Error('gis-unreachable'));
    };
    document.head.appendChild(s);
  });
  return gcalScriptPromise;
}

/* Asks Google for an access token. `interactive` false uses an existing Google session
   silently where possible; the sync path passes true so expiry surfaces as a prompt. */
function initiateGCalOAuth(interactive) {
  const clientId = getGCalClientId();
  if (!clientId) return Promise.reject(new Error('gcal-no-client-id'));

  return loadGisScript().then(() => new Promise((resolve, reject) => {
    // A fresh client each time: reassigning `callback` on a cached one leaves the
    // previous promise's resolve reachable and resolves the wrong request.
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GCAL_SCOPE,
      callback: resp => {
        if (resp && resp.access_token) {
          gcalAccessToken = resp.access_token;
          resolve(resp.access_token);
        } else {
          reject(new Error((resp && resp.error) || 'gcal-denied'));
        }
      },
      error_callback: err => reject(new Error((err && err.type) || 'gcal-denied'))
    });
    client.requestAccessToken({ prompt: interactive === false ? '' : 'consent' });
  }));
}

function gcalDisconnect() {
  const token = gcalAccessToken;
  gcalAccessToken = null;
  // Best-effort: revoking is courtesy, and failing to revoke must not look like a
  // failure to disconnect — locally we are disconnected either way.
  if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch (e) { /* ignore */ }
  }
  renderGCalPanel();
}

/* One fetch, one retry on 401. A token can expire mid-sync — between the list and the
   last write — so a single re-auth is worth it; a second failure is a real failure. */
async function callGCalAPI(path, options) {
  if (!gcalAccessToken) await initiateGCalOAuth(false);

  const send = () => fetch(GCAL_API_BASE + path, {
    ...(options || {}),
    headers: {
      'Authorization': 'Bearer ' + gcalAccessToken,
      'Content-Type': 'application/json',
      ...((options && options.headers) || {})
    }
  });

  let res;
  try { res = await send(); }
  catch (e) { throw new Error('gcal-network'); }

  if (res.status === 401) {
    gcalAccessToken = null;
    await initiateGCalOAuth(true);
    try { res = await send(); }
    catch (e) { throw new Error('gcal-network'); }
  }

  if (res.status === 204) return null;              // DELETE returns no body
  if (res.status === 410) return null;              // already gone — deleting it again is a no-op
  if (!res.ok) {
    const err = new Error('gcal-http-' + res.status);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/* Step 1 — what IS.

   MUST follow nextPageToken. events.list paginates, and a caller that reads only the
   first page sees a partial "what IS": every event beyond it looks missing and gets
   created a SECOND time. That is the duplicate bug this whole marker design exists to
   prevent, reintroduced by one unhandled field.

   No timeMin, on purpose: an assignment whose deadline passed months ago still has an
   event that must be found before it can be updated or deleted. */
async function listRecallEvents() {
  const out = [];
  let pageToken = '';
  do {
    const qs = 'privateExtendedProperty=' + encodeURIComponent(GCAL_APP_KEY + '=' + GCAL_APP_VALUE)
      + '&showDeleted=false&maxResults=250'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const page = await callGCalAPI('/calendars/primary/events?' + qs, { method: 'GET' });
    if (page && Array.isArray(page.items)) out.push(...page.items);
    pageToken = (page && page.nextPageToken) || '';
  } while (pageToken);
  return out;
}

/* Step 4 — execute the plan the pure diff produced, and write back the new ids.

   The write-back reloads the library first rather than reusing the copy read at the
   top: a sync is many awaits long, and saving a stale snapshot would silently discard
   anything edited while it ran. */
async function syncRecallToGoogleCalendar() {
  const remotes = await listRecallEvents();
  const plan = diffCalendarEvents(loadData().assignments, remotes);
  const counts = { created: 0, updated: 0, deleted: 0, skipped: plan.skipped.length };
  const idPatch = new Map();

  for (const item of plan.toCreate) {
    const created = await callGCalAPI('/calendars/primary/events', {
      method: 'POST', body: JSON.stringify(item.event)
    });
    if (created && created.id) {
      idPatch.set(item.assignment.id, created.id);
      counts.created++;
    }
  }
  for (const item of plan.toUpdate) {
    await callGCalAPI('/calendars/primary/events/' + encodeURIComponent(item.eventId), {
      method: 'PATCH', body: JSON.stringify(item.event)
    });
    counts.updated++;
  }
  for (const item of plan.toDelete) {
    await callGCalAPI('/calendars/primary/events/' + encodeURIComponent(item.eventId), {
      method: 'DELETE'
    });
    counts.deleted++;
    // An assignment that lost its due date keeps its row but must lose its stale id,
    // or the next sync tries to PATCH an event that no longer exists.
    if (item.assignmentId) idPatch.set(item.assignmentId, null);
  }

  if (idPatch.size) {
    const fresh = loadData();
    saveData({
      ...fresh,
      assignments: fresh.assignments.map(a =>
        idPatch.has(a.id) ? { ...a, gcalEventId: idPatch.get(a.id) } : a)
    });
  }
  localStorage.setItem(GCAL_LAST_SYNC_KEY, String(Date.now()));
  return counts;
}

/* ---- the panel on the Assignments screen ---- */

/* Maps a thrown sync error onto something a person can act on. Mirrors apiErrorInfo's
   split: `retryable` decides whether a Try again button appears at all, because
   offering a retry that cannot help is worse than not offering one. */
function gcalErrorInfo(err) {
  const m = (err && err.message) || '';
  if (m === 'gcal-no-client-id') {
    return { message: 'Add a Google client ID in Settings first.', retryable: false };
  }
  if (m === 'gis-unreachable' || m === 'gcal-network') {
    return { message: 'Could not reach Google. Check your connection and try again.', retryable: true };
  }
  if (m === 'gcal-denied' || m === 'access_denied' || m === 'popup_closed') {
    return { message: 'Google did not grant access. Connect again to retry.', retryable: true };
  }
  if (err && err.status === 403) {
    return { message: 'Google refused the request — check the Calendar API is enabled for this client ID.', retryable: false };
  }
  if (err && err.status === 429) {
    return { message: 'Google is rate-limiting this account. Wait a minute, then try again.', retryable: true };
  }
  if (err && err.status >= 500) {
    return { message: 'Google Calendar is having trouble. Try again in a moment.', retryable: true };
  }
  return { message: 'Sync failed. Try again.', retryable: true };
}

/* A feature that is OFF must say so — the rule earned on 2026-07-30, when an
   unconfigured backup server reported nothing at all and stayed off for two days. */
function gcalStatusLine() {
  if (!isGCalConfigured()) return 'Not set up — add a Google client ID in Settings.';
  if (!isGCalConnected()) return 'Not connected.';
  const last = gcalLastSyncAt();
  if (!last) return 'Connected. Not synced yet.';
  const days = Math.floor((Date.now() - last) / DAY);
  if (days <= 0) return 'Connected. Synced today.';
  if (days === 1) return 'Connected. Synced yesterday.';
  return 'Connected. Synced ' + days + ' days ago.';
}

function renderGCalPanel() {
  const el = document.getElementById('gcal-panel');
  if (!el) return;
  const connected = isGCalConnected();
  el.innerHTML =
    `<div class="gcal-row">` +
      `<div class="gcal-status" id="gcal-status">${escapeHtml(gcalStatusLine())}</div>` +
      `<div class="gcal-actions">` +
        (connected
          ? `<button class="btn btn-ghost btn-sm" type="button" onclick="gcalDisconnect()">Disconnect</button>` +
            `<button class="btn btn-outline btn-sm" type="button" onclick="onGCalSync()">Sync now</button>`
          : `<button class="btn btn-outline btn-sm" type="button" onclick="onGCalConnect()">Connect Google Calendar</button>`) +
      `</div>` +
    `</div>`;
}

function setGCalStatus(msg, kind, retry) {
  const el = document.getElementById('gcal-status');
  if (!el) return;
  el.className = 'gcal-status' + (kind === 'error' ? ' error' : '');
  if (kind === 'busy') {
    el.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
    return;
  }
  if (kind === 'error' && typeof retry === 'function') {
    el.innerHTML = `<span class="status-msg">${escapeHtml(msg)}</span>` +
      `<button class="btn btn-outline btn-sm status-retry" type="button">Try again</button>`;
    el.querySelector('.status-retry').onclick = retry;
    return;
  }
  el.textContent = msg || '';
}

async function onGCalConnect() {
  if (!isGCalConfigured()) {
    setGCalStatus('Add a Google client ID in Settings first.', 'error');
    openKeyModal();
    return;
  }
  setGCalStatus('Connecting…', 'busy');
  try {
    await initiateGCalOAuth(true);
    renderGCalPanel();
    toast('Google Calendar connected');
  } catch (e) {
    const info = gcalErrorInfo(e);
    setGCalStatus(info.message, 'error', info.retryable ? onGCalConnect : null);
  }
}

async function onGCalSync() {
  setGCalStatus('Syncing…', 'busy');
  try {
    const counts = await syncRecallToGoogleCalendar();
    renderGCalPanel();
    setGCalStatus(summarizeGCalSync(counts), 'ok');
  } catch (e) {
    const info = gcalErrorInfo(e);
    setGCalStatus(info.message, 'error', info.retryable ? onGCalSync : null);
  }
}

/* ── 1F. ASSIGNMENTS — CRUD ──────────────────────────────────────
   The impure half. Every write funnels through saveData(), so the #19 write lock
   covers these paths too.

   `data.assignments` is read directly, with NO `|| []` fallback. That is deliberate:
   a fallback would mask a reverted whitelist as "the assignment vanishes on reload",
   which is exactly the silent failure this feature was built to prevent. Without it
   the seam fails loudly and a named test can prove it.
   ---------------------------------------------------------------- */

function createAssignment(fields) {
  const data = loadData();
  const assignment = { id: newId('asg'), ...normalizeAssignment(fields, Date.now()) };
  saveData({ ...data, assignments: [...data.assignments, assignment] });
  return assignment;
}

function updateAssignment(id, fields) {
  const data = loadData();
  const assignments = data.assignments.map(a =>
    a.id === id ? { ...a, ...normalizeAssignment({ ...a, ...fields }, a.createdAt) } : a);
  saveData({ ...data, assignments });
}

function toggleAssignmentDone(id) {
  const data = loadData();
  const assignments = data.assignments.map(a => a.id === id ? { ...a, done: !a.done } : a);
  saveData({ ...data, assignments });
}

function deleteAssignment(id) {
  const data = loadData();
  saveData({ ...data, assignments: data.assignments.filter(a => a.id !== id) });
}

/* ── PURE pomodoro ───────────────────────────────────────────────
   1H. POMODORO — the focus timer (feature #34), pure half.

   Everything here is a plain function of its arguments: no clock of its own, no DOM,
   no audio. `now` is always passed in, so "has the block finished" is testable without
   waiting 25 minutes.

   THIS BLOCK MUST NOT REFERENCE ANYTHING OUTSIDE ITSELF. (C) test-pomodoro.mjs lifts it
   out with new Function() and evaluates it standalone; naming an outside identifier
   (DAY, dayKey, startOfDay) throws a ReferenceError that takes the whole slice down and
   fakes a failure for every check in the suite.

   WHY POMODOROS ARE NOT IN `log`. The brief asked for data.log[date].pomodoros.
   `log[date]` is a REVIEW COUNT, read as a number in five places — the streak, the
   longest streak, the 7-day total, the stat cards and the heatmap. Making it an object
   turns `(log[k] || 0) > 0` into false and `sum += log[k]` into the string
   "0[object Object]", so the streak silently resets, the heatmap empties and
   gamification (which reads the streak) goes with it. Measured before it was written.
   `data.pomodoros` is a separate top-level key, which costs five rebuild sites and
   breaks nothing. Pinned by check E8.
   ---------------------------------------------------------------- */

const POMODORO_FOCUS_SECONDS = 25 * 60;
const POMODORO_BREAK_SECONDS = 5 * 60;
/* Untagged decks get ONE named bucket rather than an empty-string key, which would
   render as a blank row in the stats and read as a rendering bug. */
const POMODORO_NO_SUBJECT = 'Sem disciplina';

function pomodoroPad2(n) { return String(n).padStart(2, '0'); }

/* MM:SS, fixed width. Minutes are NOT wrapped at 60 — this is a duration, not a wall
   clock, so a 90-minute block reads 90:00 and never 30:00. Anything negative or
   unparseable clamps to 00:00: a late tick must not paint "-1:-1" on the screen. */
function formatTime(seconds) {
  const s = Number(seconds);
  const safe = Number.isFinite(s) && s > 0 ? Math.floor(s) : 0;
  return pomodoroPad2(Math.floor(safe / 60)) + ':' + pomodoroPad2(safe % 60);
}

/* Elapsed time comes from real timestamps, never from counting ticks.

   A background tab is throttled and may not fire for minutes at a time, so a tick
   counter drifts and a 25-minute block silently becomes 40. Subtracting two Date.now()
   values is immune to that: the app can wake up an hour late and still report `done`
   with 0 remaining, which is what check B6 pins.

   `pausedAt` freezes the clock — elapsed is measured to the pause, not to now — so
   leaving a paused timer overnight does not silently complete a block (B8). A
   backwards clock jump (NTP correction) clamps to 0 rather than going negative (B11). */
function calculateTimerState(startTime, duration, pausedAt, now) {
  const dur = Number(duration) > 0 ? Number(duration) : 0;
  if (!startTime) return { remaining: dur, done: false, progress: 0 };

  const end = pausedAt ? Number(pausedAt) : Number(now);
  let elapsedMs = end - Number(startTime);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) elapsedMs = 0;

  const elapsed = Math.floor(elapsedMs / 1000);
  const remaining = Math.max(0, dur - elapsed);
  const progress = dur === 0 ? 100 : Math.min(100, Math.max(0, (elapsed / dur) * 100));
  return { remaining, done: remaining === 0, progress };
}

/* A completed block, counted per subject per day. Returns a NEW object at both levels
   — the map and the day inside it — because a nested spread that reuses the day object
   would mutate the caller's library in place. Pinned by C5.

   Corrupt shapes degrade rather than throw: a day that is a number, or a count that is
   not a number, restarts at 1. A NaN here would poison every total that reads it. */
function logPomodoro(pomodoros, subject, dateStr) {
  const map = (pomodoros && typeof pomodoros === 'object') ? pomodoros : {};
  const key = String(dateStr);
  const subj = String(subject == null ? '' : subject).trim() || POMODORO_NO_SUBJECT;

  const dayRaw = map[key];
  // Array.isArray matters: typeof [] is 'object', and spreading an array yields index
  // keys — {...[1,2]} is {0:1,1:2}, which would invent subjects named "0" and "1".
  const day = (dayRaw && typeof dayRaw === 'object' && !Array.isArray(dayRaw)) ? dayRaw : {};
  const prev = Number(day[subj]);

  return { ...map, [key]: { ...day, [subj]: Number.isFinite(prev) && prev > 0 ? prev + 1 : 1 } };
}

/* Decks have no `subject` field — only assignments do. The deck's `tag` is the
   existing categorisation, so it is what a pomodoro is filed under. One function, so
   that decision lives in one place instead of at every call site. */
function deckSubject(deck) {
  return String((deck && deck.tag) || '').trim() || POMODORO_NO_SUBJECT;
}

/* Lifetime totals per subject. A corrupt day is skipped, not thrown on: one bad entry
   must not take down the whole stat. */
function pomodoroTotals(pomodoros) {
  const map = (pomodoros && typeof pomodoros === 'object') ? pomodoros : {};
  const out = {};
  for (const key of Object.keys(map)) {
    const day = map[key];
    // Arrays rejected for the same reason as in logPomodoro: Object.keys([5,6]) is
    // ['0','1'], which would add two junk subjects to a lifetime total.
    if (!day || typeof day !== 'object' || Array.isArray(day)) continue;
    for (const subj of Object.keys(day)) {
      const n = Number(day[subj]);
      if (!Number.isFinite(n)) continue;
      out[subj] = (out[subj] || 0) + n;
    }
  }
  return out;
}
/* ── END PURE pomodoro */

/* ── 1H-impure. POMODORO — loop, sound, persistence ──────────────
   The thin outside half: a tick, a beep, and one write. Everything decidable lives in
   the pure block above.

   ONE timer across Study, Cram and Quiz on purpose — it is one study session, and a
   timer that resets when you switch from cards to a quiz would be measuring the screen
   rather than the work.
   ---------------------------------------------------------------- */

let pomodoroStart = null;      // ms timestamp the current block began
let pomodoroPausedAt = null;   // ms timestamp of the pause, or null while running
let pomodoroMode = 'focus';    // 'focus' | 'break'
let pomodoroTickId = null;
let pomodoroAudioCtx = null;

function pomodoroDuration() {
  return pomodoroMode === 'break' ? POMODORO_BREAK_SECONDS : POMODORO_FOCUS_SECONDS;
}
function pomodoroRunning() { return pomodoroStart !== null && pomodoroPausedAt === null; }

/* A short two-note blip, synthesised on the spot.

   No file, no CDN: an <audio src> would be one more thing to precache and one more way
   for the offline guarantee (#26) to develop a hole. The Web Audio API is in the
   browser already. Wrapped in try/catch and silent on failure — a timer whose sound
   card is busy must still keep time. */
function pomodoroBeep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!pomodoroAudioCtx) pomodoroAudioCtx = new Ctx();
    const ctx = pomodoroAudioCtx;
    // Autoplay policy parks the context until a gesture; the Play button is that gesture.
    if (ctx.state === 'suspended') ctx.resume();

    const t0 = ctx.currentTime;
    [{ at: 0, hz: 880 }, { at: 0.22, hz: 1174.66 }].forEach(n => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = n.hz;
      // Ramped, never a hard start/stop — a square-edged gain is an audible click.
      gain.gain.setValueAtTime(0.0001, t0 + n.at);
      gain.gain.exponentialRampToValueAtTime(0.16, t0 + n.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + 0.2);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + n.at);
      osc.stop(t0 + n.at + 0.22);
    });
  } catch (e) { /* sound is a courtesy; it must never take the timer down */ }
}

/* 250ms, and the interval is only a REPAINT trigger — it never accumulates time.
   Every reading comes from calculateTimerState() comparing real timestamps, so a
   throttled background tab repaints late but is never wrong. */
function startPomodoroTicking() {
  if (pomodoroTickId !== null) return;
  pomodoroTickId = setInterval(pomodoroTick, 250);
}
function stopPomodoroTicking() {
  if (pomodoroTickId === null) return;
  clearInterval(pomodoroTickId);
  pomodoroTickId = null;
}

function pomodoroTick() {
  const s = calculateTimerState(pomodoroStart, pomodoroDuration(), pomodoroPausedAt, Date.now());
  renderPomodoro();
  if (!s.done || pomodoroPausedAt !== null) return;

  stopPomodoroTicking();
  pomodoroBeep();

  if (pomodoroMode === 'focus') {
    // Only completed FOCUS blocks are counted. A break is rest, not work, and a
    // half-finished block is not a pomodoro.
    recordPomodoroForCurrentDeck();
    pomodoroMode = 'break';
    pomodoroStart = Date.now();
    pomodoroPausedAt = null;
    startPomodoroTicking();          // the break runs on its own; that is the point
    toast('Focus block done — 5 minute break');
  } else {
    // The break ends ARMED BUT STOPPED. Starting a new focus block for someone who
    // has walked away would count time nobody spent studying.
    pomodoroMode = 'focus';
    pomodoroStart = null;
    pomodoroPausedAt = null;
    toast('Break over — press play when you are back');
  }
  renderPomodoro();
}

function recordPomodoroForCurrentDeck() {
  try {
    const data = loadData();
    const subject = deckSubject(getDeck(currentDeckId));
    saveData({ ...data, pomodoros: logPomodoro(data.pomodoros, subject, dayKey(Date.now())) });
  } catch (e) {
    // saveData refuses to write when the last read failed (#19). Losing the count is
    // the correct trade against overwriting a library we could not read.
    console.warn('pomodoro not recorded:', e);
  }
}

function onPomodoroToggle() {
  if (pomodoroStart === null) {
    pomodoroStart = Date.now();
    pomodoroPausedAt = null;
  } else if (pomodoroPausedAt !== null) {
    // Resume by shifting the start forward by however long the pause lasted, so the
    // remaining time is exactly what it was when paused.
    pomodoroStart += Date.now() - pomodoroPausedAt;
    pomodoroPausedAt = null;
  } else {
    pomodoroPausedAt = Date.now();
  }
  if (pomodoroRunning()) startPomodoroTicking(); else stopPomodoroTicking();
  renderPomodoro();
}

function onPomodoroReset() {
  stopPomodoroTicking();
  pomodoroStart = null;
  pomodoroPausedAt = null;
  pomodoroMode = 'focus';
  renderPomodoro();
}

function renderPomodoro() {
  const slots = document.querySelectorAll('.pomodoro-slot');
  if (!slots.length) return;
  const s = calculateTimerState(pomodoroStart, pomodoroDuration(), pomodoroPausedAt, Date.now());
  const label = pomodoroMode === 'break' ? 'BREAK' : 'FOCUS';
  const running = pomodoroRunning();
  const html =
    `<span class="pomo-state">[${label}]</span>` +
    `<span class="pomo-clock">${formatTime(s.remaining)}</span>` +
    `<button class="pomo-btn" type="button" onclick="onPomodoroToggle()" ` +
      `aria-label="${running ? 'Pause' : 'Start'} the focus timer">${running ? '❚❚' : '▶'}</button>` +
    `<button class="pomo-btn" type="button" onclick="onPomodoroReset()" ` +
      `aria-label="Reset the focus timer">↺</button>`;
  slots.forEach(el => { el.innerHTML = html; });
}

/* ----------------------------------------------------------------
   2. SM-2 SCHEDULER
   ----------------------------------------------------------------
   The classic spaced-repetition idea: after you see a card you rate
   how it went, and the app decides WHEN to show it next.
     • interval — days until the card is next due
     • ease     — a multiplier; cards you know stretch out faster
     • reps     — how many times in a row you've got it right
   Rate it well and the interval grows (days → weeks → months); rate
   it "Again" and it resets and comes back this session. This is a
   simplified, Anki-style take on the SM-2 algorithm. */

function schedule(srs, rating) {
  let { interval, ease, reps, lapses } = srs;
  const now = Date.now();

  if (rating === 'again') {
    reps = 0;
    lapses += 1;
    ease = Math.max(1.3, ease - 0.20);
    interval = 0;                       // relearn — comes back this session
  } else if (rating === 'hard') {
    ease = Math.max(1.3, ease - 0.15);
    interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
    reps += 1;
  } else if (rating === 'good') {
    if (reps === 0) interval = 1;       // first pass → tomorrow
    else if (reps === 1) interval = 6;  // second pass → ~a week
    else interval = Math.max(1, Math.round(interval * ease));
    reps += 1;
  } else if (rating === 'easy') {
    ease = ease + 0.15;
    if (reps === 0) interval = 4;
    else interval = Math.max(1, Math.round(interval * ease * 1.3));
    reps += 1;
  }

  const due = rating === 'again' ? now : now + interval * DAY;
  return { due, interval, ease, reps, lapses, last: now };
}

function formatInterval(days) {
  if (days <= 0) return '<10m';
  if (days < 1) return '<1d';
  if (days === 1) return '1d';
  if (days < 30) return days + 'd';
  if (days < 365) return Math.round(days / 30) + 'mo';
  return (days / 365).toFixed(1) + 'y';
}

/* What each button would do to the current card, for the labels. */
function previewLabel(srs, rating) {
  if (rating === 'again') return '<10m';
  return formatInterval(schedule(srs, rating).interval);
}

/* ----------------------------------------------------------------
   3. SCREEN ROUTER
   ---------------------------------------------------------------- */

function showScreen(id) {
  stopSpeech();   // leaving a screen always silences the card being read (feature #18)
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');
  window.scrollTo(0, 0);
  // Pomodoro (feature #34). Hooked HERE rather than in startReview/startQuiz/startCram
  // because all three funnel through this function — one call instead of three that
  // could drift apart. The slots only exist on those screens, so this is a no-op
  // everywhere else, and a running timer is unaffected by navigating away.
  renderPomodoro();
}
function setCrumb(text) { document.getElementById('nav-crumb').textContent = text || ''; }
function setActiveTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  if (tab) document.getElementById('tab-' + tab).classList.add('active');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ----------------------------------------------------------------
   4. DECKS HOME
   ---------------------------------------------------------------- */

/* ── 4A. Library filter + search (pure helpers, no DOM) ── */

const SEARCH_RESULTS_MAX = 50;   // a one-letter query shouldn't paint hundreds of rows

/* Lowercase + strip accents so "revolucao" matches "Revolução" and vice versa.
   NFD decomposes each accented letter into base letter + combining mark
   (ç → c + cedilla); the replace then drops the marks. Must be applied to
   BOTH sides of a comparison — the query and the text being searched. */
function foldText(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizeQuery(str) {
  return foldText(str).trim();
}

/* Non-empty deck tags, deduped case-insensitively (first-seen casing wins), sorted. */
function uniqueTags(decks) {
  const seen = new Map();
  for (const d of decks) {
    const tag = (d.tag || '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/* tag: exact match (case-insensitive) or null. query: substring of name or tag,
   accent-insensitive on both sides. Both must hold. */
function filterDecks(decks, { tag, query }) {
  const q = normalizeQuery(query);
  return decks.filter(d => {
    if (tag && (d.tag || '').toLowerCase() !== tag.toLowerCase()) return false;
    if (!q) return true;
    return foldText(d.name).includes(q) || foldText(d.tag).includes(q);
  });
}

/* Global card search: substring on front/back, annotated with deck name, capped. */
function searchCards(cards, decks, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const deckById = new Map(decks.map(d => [d.id, d]));
  const hits = [];
  for (const c of cards) {
    if (hits.length >= SEARCH_RESULTS_MAX) break;
    const deck = deckById.get(c.deckId);
    if (!deck) continue;   // orphaned card — defensive, deleteDeck already cascades
    if (!foldText(c.front).includes(q) && !foldText(c.back).includes(q)) continue;
    hits.push({ id: c.id, deckId: c.deckId, deckName: deck.name, front: c.front, back: c.back });
  }
  return hits;
}

/* Global assignment search: substring on title or subject, accent-insensitive, capped.
   Mirrors searchCards deliberately — same shape in, same shape out, so globalSearch
   can treat the three the same way. Done assignments ARE included: "when was that
   thing due" is a real question after it is ticked off, and the row carries `done`
   so the UI can show it greyed rather than hide it. */
function searchAssignments(assignments, query) {
  const q = normalizeQuery(query);
  if (!q) return [];
  const hits = [];
  for (const a of assignments) {
    if (hits.length >= SEARCH_RESULTS_MAX) break;
    // foldText coerces null/undefined to '', so a half-formed row from an old
    // backup is skipped rather than throwing and taking the whole overlay down.
    if (!foldText(a.title).includes(q) && !foldText(a.subject).includes(q)) continue;
    hits.push({ id: a.id, title: a.title, subject: a.subject, dueAt: a.dueAt, done: a.done === true });
  }
  return hits;
}

/* One query over the whole library, for the ⌘K overlay (feature #28).

   THE EMPTY-QUERY GUARD IS THE POINT. filterDecks() is a FILTER: given no query it
   returns every deck, which is correct for the Decks screen and catastrophic for a
   search box — opening ⌘K and typing nothing would paint the entire library as
   "results". So this returns early before filterDecks is ever reached.

   Missing keys degrade to empty lists rather than throwing: saved data from before
   #27 has no `assignments` at all. */
function globalSearch(library, query) {
  const q = normalizeQuery(query);
  if (!q) return { decks: [], cards: [], assignments: [], total: 0 };

  const lib   = library || {};
  const decks = lib.decks || [];
  const deckHits       = filterDecks(decks, { tag: null, query }).slice(0, SEARCH_RESULTS_MAX);
  const cardHits       = searchCards(lib.cards || [], decks, query);
  const assignmentHits = searchAssignments(lib.assignments || [], query);

  return {
    decks: deckHits,
    cards: cardHits,
    assignments: assignmentHits,
    // One number so the UI can say "no matches" once instead of three times.
    total: deckHits.length + cardHits.length + assignmentHits.length
  };
}

/* Flatten the three groups into the exact order the overlay paints them.

   Why this is a function and not a loop inside the renderer: the keyboard walks a
   FLAT list while the screen shows three headed groups. If those two ever disagree
   about order, ↓↓↓ Enter opens the wrong thing — and a screenshot of it looks
   perfect. One ordering, one place, checked by C1. */
function searchRows(results) {
  const r = results || {};
  const rows = [];
  for (const d of r.decks || [])
    rows.push({ type: 'deck', id: d.id, deckId: d.id, label: d.name || '', sub: d.tag || 'Deck' });
  for (const c of r.cards || [])
    rows.push({ type: 'card', id: c.id, deckId: c.deckId, label: c.front || '', sub: c.deckName || '' });
  for (const a of r.assignments || [])
    rows.push({ type: 'assignment', id: a.id, deckId: '', label: a.title || '', sub: a.subject || 'Assignment' });
  return rows;
}

/* What to show instead of rows. An untouched box must NOT say "no matches" — that
   accuses you of failing before you have typed anything. */
function searchEmptyState(query, total) {
  if (!normalizeQuery(query)) {
    return { show: true, text: 'Type to search your decks, cards and assignments.' };
  }
  if (!total) return { show: true, text: 'No matches for “' + query + '”.' };
  return { show: false, text: '' };
}

function goDecks() {
  setCrumb('');
  setActiveTab('decks');
  renderDecks();
  showScreen('decks');
}

/* Transient filter state — never saved; a page refresh starts unfiltered. */
let activeTag = null;      // the selected tag chip (display casing), or null = All
let renderedTags = [];     // tags as last rendered; chips click by index into this

/* The dashboard header + the two top panels (feature #20). Everything here is
   derived from data we already store — nothing new is tracked.

   Note what is deliberately absent: the prototype's "Retention 84%". The study
   log records how many reviews happened each day, never whether they were
   right, so retention cannot be computed. "Reviewed 7d" is real data in its
   place. See 01 Design/(C) Home dashboard + stats redesign.md */
function goHome() {
  setCrumb('');
  setActiveTab('home');
  renderHome();
  showScreen('home');
}

/* ── PURE home-layout ────────────────────────────────────────────
   6B. THE "FOCUS" HOME LAYOUT (feature #30), pure half.

   Why it exists: the vault names Diogo's blind spot outright — "gets overwhelmed by
   information overload." Split shows five things at once (greeting, due panel, stats,
   assignments, heatmap). Focus shows three: a number, a button, a line.

   It is an OPTION. Split remains the default and is not modified.

   Sliced by "04 System/(C) test-focus.mjs" — must stay free of DOM and localStorage.
   ---------------------------------------------------------------- */

const HOME_LAYOUT_KEY = 'recall.settings.homeLayout';
const HOME_LAYOUTS = ['split', 'focus'];

/* Anything that is not exactly 'focus' reads as 'split'. Deliberately strict: a
   corrupted or hand-edited value must not strand someone in a layout they never
   chose and might not know how to leave. */
function parseHomeLayout(raw) {
  return raw === 'focus' ? 'focus' : 'split';
}

function nextHomeLayout(current) {
  return parseHomeLayout(current) === 'focus' ? 'split' : 'focus';
}

/* Which parts of Home this layout renders. One object, so the render function reads
   as a list of decisions rather than a pile of if-statements — and so the decisions
   are testable without a browser.

   Every value is an explicit boolean. A missing key would read as undefined, which is
   falsy, so a typo in a section name would quietly HIDE that section instead of
   failing loudly. Check F17 pins that. */
function homeSections(layout) {
  const focus = parseHomeLayout(layout) === 'focus';
  return {
    // The three the spec asked for.
    dueNumber:    true,
    reviewButton: true,
    estimate:     true,

    // NOT hidden in Focus, on purpose. This is the #19 data-loss warning and the
    // 2026-07-30 "your backups are off" notice. It is safety, not decoration —
    // a tidy screen that stops warning you is how the Descobrimentos deck died.
    backupNudge:  true,

    // Always reachable, or Focus becomes a trap whose only exit is clearing
    // localStorage.
    layoutToggle: true,

    // Everything Focus removes.
    greeting:     !focus,
    stats:        !focus,
    assignments:  !focus,
    heatmap:      !focus,
    browseButton: !focus
  };
}

/* ── END PURE home-layout ── */

/* Read the stored layout. Wrapped because localStorage throws in private mode, and a
   preference is never a reason to take the Home screen down. */
function currentHomeLayout() {
  try { return parseHomeLayout(localStorage.getItem(HOME_LAYOUT_KEY)); }
  catch (e) { return 'split'; }
}

function onToggleHomeLayout() {
  const next = nextHomeLayout(currentHomeLayout());
  try { localStorage.setItem(HOME_LAYOUT_KEY, next); } catch (e) { /* private mode */ }
  renderHome();
}

/* Apply the section plan to the DOM. Every element the plan names is switched here and
   nowhere else, so "what does Focus hide" has exactly one answer in the code. */
function applyHomeLayout(layout) {
  const s = homeSections(layout);
  const show = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden-by-layout', !on);
  };
  show('dash-header', s.greeting);
  show('dash-stats-panel', s.stats);
  show('dash-assignments', s.assignments);
  show('dash-activity', s.heatmap);
  show('dash-browse-btn', s.browseButton);

  // The toggle itself: always present, and it says where it takes you.
  const btn = document.getElementById('home-layout-btn');
  if (btn) {
    const focus = layout === 'focus';
    btn.textContent = focus ? 'Show full dashboard' : 'Focus mode';
    btn.setAttribute('aria-pressed', focus ? 'true' : 'false');
  }
  document.getElementById('screen-home').classList.toggle('home-focus', layout === 'focus');
}

function renderHome() {
  const data = loadData();
  renderBackupNudge();     // must run AFTER loadData, which is what arms the lock
  renderDashboard(data);
  // Its own line, deliberately OUTSIDE renderDashboard: that function returns early
  // when there are no decks, so a call placed inside would hide the panel from exactly
  // the person this feature was designed for — someone who logs a Filosofia test before
  // creating a Filosofia deck. Pinned by check W5.
  renderAssignmentsPanel(data);
  // LAST, deliberately. renderDashboard and renderAssignmentsPanel both set
  // .style.display on the elements this hides; running the layout first would let
  // them undo it. Pinned by the live check.
  applyHomeLayout(currentHomeLayout());
}

function renderDashboard(data) {
  const now = new Date();
  document.getElementById('dash-date').textContent =
    now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  document.getElementById('dash-greeting').textContent = greetingFor(now) + '.';

  const panels = document.getElementById('dash-panels');
  const activity = document.getElementById('dash-activity');
  const empty = document.getElementById('home-empty');

  if (data.decks.length === 0) {
    panels.style.display = 'none';
    activity.style.display = 'none';
    empty.innerHTML = `
      <div class="empty">
        <div class="empty-title">Nothing to study yet</div>
        <div class="empty-sub">Create a deck by hand, generate one from your notes with AI, or load a sample to see how studying works.</div>
        <div class="empty-actions">
          <button class="btn btn-primary" onclick="openDeckModal()">+ Create a deck</button>
          <button class="btn btn-outline" onclick="goGenerate()">✦ Generate with AI</button>
          <button class="btn btn-outline" onclick="loadSampleDeck()">Load sample deck</button>
        </div>
      </div>`;
    return;
  }
  empty.innerHTML = '';
  panels.style.display = '';
  activity.style.display = '';

  const due = data.cards.filter(c => (c.srs?.due ?? 0) <= Date.now()).length;
  const decksWithDue = data.decks.filter(d => dueCount(d.id) > 0).length;

  document.getElementById('due-big').textContent = due;
  document.getElementById('due-sub').textContent = due === 0
    ? 'Nothing due right now. Cram a deck if you want extra practice.'
    : `Across ${decksWithDue} deck${decksWithDue === 1 ? '' : 's'} · about ${estimateMinutes(due)} minutes of review`;

  const reviewBtn = document.getElementById('dash-review-btn');
  reviewBtn.disabled = due === 0;
  reviewBtn.textContent = due === 0 ? 'Nothing due' : 'Start review';

  // Freeze-aware, same as Progress. A read, never syncGamification() — renderDashboard
  // runs on every Home render and must not write. Sibling of the bug found on the
  // Progress screen: two streak numbers in one app is worse than either being wrong.
  document.getElementById('dash-streak').textContent =
    calculateStreak(data.log, normalizeGamification(data.gamification).frozenDays, Date.now());
  document.getElementById('dash-total').textContent = data.cards.length;
  document.getElementById('dash-week').textContent = reviewsInLastDays(data.log, 7);

  document.getElementById('dash-heatmap').innerHTML = heatmapGridHtml(data.log);
}

/* "Start review" from the dashboard: jump straight into the deck with the most
   cards due, rather than inventing a cross-deck queue. Reviewing one subject at
   a time is also better studying than shuffling three together. */
function startDueReview() {
  const data = loadData();
  const best = data.decks
    .map(d => ({ id: d.id, due: dueCount(d.id) }))
    .filter(d => d.due > 0)
    .sort((a, b) => b.due - a.due)[0];
  if (!best) { toast('Nothing is due right now'); return; }
  currentDeckId = best.id;
  startReview();
}

function renderDecks() {
  const data = loadData();
  const body = document.getElementById('decks-body');
  const newDeckBtn = document.getElementById('new-deck-btn');
  const genCta = document.getElementById('gen-cta');
  const searchWrap = document.getElementById('deck-search-wrap');

  if (data.decks.length === 0) {
    newDeckBtn.style.display = 'none';
    genCta.style.display = 'none';
    searchWrap.style.display = 'none';
    body.innerHTML = `
      <div class="empty">
        <div class="empty-title">No decks yet</div>
        <div class="empty-sub">Create a deck by hand, generate one from your notes with AI, or load a sample to see how studying works.</div>
        <div class="empty-actions">
          <button class="btn btn-primary" onclick="openDeckModal()">+ Create a deck</button>
          <button class="btn btn-outline" onclick="goGenerate()">✦ Generate with AI</button>
          <button class="btn btn-outline" onclick="loadSampleDeck()">Load sample deck</button>
        </div>
      </div>`;
    return;
  }

  newDeckBtn.style.display = '';
  genCta.style.display = '';
  searchWrap.style.display = '';
  const query = document.getElementById('deck-search').value;
  const tags = uniqueTags(data.decks);
  renderedTags = tags;
  // The selected tag can vanish (deck deleted, backup imported) — fall back to All.
  if (activeTag && !tags.some(t => t.toLowerCase() === activeTag.toLowerCase())) activeTag = null;

  const shownDecks = filterDecks(data.decks, { tag: activeTag, query });
  const hits = searchCards(data.cards, data.decks, query);
  body.innerHTML = renderAudioNudge(data) + renderTagRow(tags)
    + renderDeckGrid(shownDecks, data, query) + renderCardResults(hits, query);
}

/* How many card clips Kokoro has not generated yet, and the button that asks
   for them. Renders nothing at all once you are up to date, so it is invisible
   in the normal case — the same shape the backup nudge (#19) needs.
   Counts card clips only, never the Test Voice samples: those are not cards. */
function renderAudioNudge(data) {
  const missing = cardClips(data).filter(e => !hasClip(e.h)).length;
  if (missing === 0) return '';
  return `<div class="audio-nudge">
      <span>🔊 ${missing} card clip${missing === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no audio yet</span>
      <button class="btn btn-outline btn-sm" onclick="onPrepareAudio()">Prepare audio</button>
    </div>`;
}

/* Write out everything the Kokoro generator needs. The manifest carries the
   cleaned text AND the final filename for every clip, so the Python side never
   cleans text and never hashes anything — the reason the two halves cannot
   drift apart. See 01 Design/(C) Audio TTS — Kokoro engine.md */
function onPrepareAudio() {
  const entries = audioManifest(loadData());
  if (entries.length === 0) { toast('Nothing to generate yet — add some cards first'); return; }
  const missing = entries.filter(e => !hasClip(e.h)).length;
  downloadFile('recall-audio-manifest.json',
    new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' }));
  toast(missing === 0
    ? 'Manifest saved — every clip already exists'
    : missing + ' clip' + (missing === 1 ? '' : 's') + ' to generate — now run the generator script');
}

function renderTagRow(tags) {
  if (tags.length === 0) return '';
  const allChip = `<button class="tag-chip ${activeTag === null ? 'active' : ''}" onclick="onTagChip(-1)">All</button>`;
  const chips = tags.map((t, i) =>
    `<button class="tag-chip ${activeTag === t ? 'active' : ''}" onclick="onTagChip(${i})">${escapeHtml(t)}</button>`
  ).join('');
  return `<div class="tag-row">${allChip}${chips}</div>`;
}

/* Chips pass an index, not the tag text: a tag is user text, and inlining it
   into onclick="..." breaks on quotes even after escaping (the browser decodes
   entities in attributes before the JS runs). */
function onTagChip(index) {
  if (index === -1) activeTag = null;
  else activeTag = (activeTag === renderedTags[index]) ? null : renderedTags[index];
  renderDecks();
}

function renderDeckGrid(decks, data, query) {
  if (decks.length === 0) {
    // Decks exist, they're just filtered out — a quiet note, not the big empty state.
    return normalizeQuery(query) ? '' : '<div class="filter-empty">No decks match.</div>';
  }
  const sorted = [...decks].sort((a, b) => b.createdAt - a.createdAt);
  return '<div class="decks-grid">' + sorted.map(d => {
    const total = data.cards.filter(c => c.deckId === d.id).length;
    const due = dueCount(d.id);
    const dueHtml = due > 0
      ? `<span class="due-pill" style="color:var(--warning)">${due} due</span> · ${total} card${total === 1 ? '' : 's'}`
      : (total > 0
          ? `<span class="due-pill" style="color:var(--success)">Up to date</span> · ${total} card${total === 1 ? '' : 's'}`
          : 'No cards yet');
    const m = deckMastery(data.cards.filter(c => c.deckId === d.id));
    return `
      <button class="deck-card" onclick="goDeck('${d.id}')">
        ${d.tag ? `<span class="deck-card-tag">${escapeHtml(d.tag)}</span>` : ''}
        <span class="deck-card-title">${escapeHtml(d.name)}</span>
        <span class="deck-card-meta">${dueHtml}</span>
        ${total > 0 ? `
        <span class="deck-bar-header"><span>Mastery</span><span>${m.pct}%</span></span>
        <span class="bar-track"><span class="bar-fill" style="width:${m.pct}%"></span></span>` : ''}
      </button>`;
  }).join('') + '</div>';
}

function renderCardResults(hits, query) {
  const q = normalizeQuery(query);
  if (!q) return '';
  if (hits.length === 0) {
    return `<div class="filter-empty">No matches for “${escapeHtml(query.trim())}”.</div>`;
  }
  const count = hits.length >= SEARCH_RESULTS_MAX ? `${SEARCH_RESULTS_MAX}+` : hits.length;
  const rows = hits.map(m => `
    <button class="search-hit" onclick="goDeck('${m.deckId}')">
      <span class="search-hit-front">${escapeHtml(m.front)}</span>
      <span class="search-hit-deck">${escapeHtml(m.deckName)}</span>
    </button>`).join('');
  return `
    <div class="section-label"><h2>Cards</h2><span class="count">${count}</span></div>
    <div class="search-hits">${rows}</div>`;
}

/* ----------------------------------------------------------------
   5. NEW DECK MODAL
   ---------------------------------------------------------------- */

function openDeckModal() {
  document.getElementById('deck-name').value = '';
  document.getElementById('deck-tag').value = '';
  document.getElementById('deck-error').textContent = '';
  fillLangSelect(document.getElementById('new-deck-lang'), SPEECH_DEFAULT_LANG);
  // No speech engine → no point asking which voice to use.
  document.getElementById('new-deck-lang-field').style.display = speechSupported() ? '' : 'none';
  document.getElementById('deck-modal').classList.add('open');
  setTimeout(() => document.getElementById('deck-name').focus(), 50);
}
function closeDeckModal() { document.getElementById('deck-modal').classList.remove('open'); }

function onCreateDeck() {
  const name = document.getElementById('deck-name').value.trim();
  const tag = document.getElementById('deck-tag').value.trim();
  if (!name) { document.getElementById('deck-error').textContent = 'Give your deck a name.'; return; }
  const deck = createDeck(name, tag, document.getElementById('new-deck-lang').value);
  closeDeckModal();
  toast('Deck created');
  goDeck(deck.id);
}

/* ----------------------------------------------------------------
   6. DECK VIEW + MANUAL CARD CREATION
   ---------------------------------------------------------------- */

let currentDeckId = null;
let editingCardId = null;   // which card is open in inline-edit mode (null = none)

function goDeck(deckId) {
  const deck = getDeck(deckId);
  if (!deck) { goDecks(); return; }
  currentDeckId = deckId;
  editingCardId = null;
  setCrumb(deck.name);
  setActiveTab(null);

  document.getElementById('deck-title').textContent = deck.name;
  document.getElementById('deck-tag-line').textContent = deck.tag ? deck.tag : 'Deck';
  // AI summary panel — only decks that got cards via Generate have one.
  const sumWrap = document.getElementById('deck-summary-wrap');
  sumWrap.style.display = deck.summary ? '' : 'none';
  sumWrap.open = false;
  document.getElementById('deck-summary-text').textContent = deck.summary || '';
  document.getElementById('card-front').value = '';
  document.getElementById('card-back').value = '';
  document.getElementById('card-error').textContent = '';

  fillLangSelect(document.getElementById('deck-lang'), deck.lang);
  refreshSpeechUi();

  renderCards();
  showScreen('deck');
  setTimeout(() => document.getElementById('card-front').focus(), 50);
}

function renderCards() {
  const cards = cardsForDeck(currentDeckId);
  const due = dueCount(currentDeckId);
  document.getElementById('cards-count').textContent = cards.length;
  document.getElementById('study-btn').disabled = cards.length === 0;
  document.getElementById('study-btn').textContent = due > 0 ? `Study (${due} due)` : 'Study';
  const quizBtn = document.getElementById('quiz-btn');
  quizBtn.disabled = cards.length < QUIZ_MIN;
  quizBtn.title = cards.length < QUIZ_MIN ? `Need at least ${QUIZ_MIN} cards to quiz` : '';
  const chatBtn = document.getElementById('chat-btn');
  const chatKind = buildChatContext(getDeck(currentDeckId), cards).kind;
  chatBtn.disabled = chatKind === 'none';
  chatBtn.title = chatKind === 'none' ? 'Add cards or material before chatting' : '';
  const artifactsBtn = document.getElementById('artifacts-btn');
  artifactsBtn.disabled = chatKind === 'none'; // same material rule as chat
  artifactsBtn.title = chatKind === 'none' ? 'Add cards or material before building artifacts' : '';

  const dueLine = document.getElementById('deck-due-line');
  if (cards.length === 0) dueLine.textContent = '';
  else if (due > 0) dueLine.innerHTML = `<span style="color:var(--warning);font-weight:600">${due} card${due === 1 ? '' : 's'} due</span> · ${cards.length} total`;
  else dueLine.innerHTML = `<span style="color:var(--success);font-weight:600">All caught up</span> · ${cards.length} card${cards.length === 1 ? '' : 's'}`;

  const body = document.getElementById('cards-body');
  if (cards.length === 0) {
    body.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No cards yet. Add one above, or generate a batch with AI.</div>
    </div>`;
    return;
  }
  body.innerHTML = [...cards].reverse().map(c => {
    if (c.id === editingCardId) {
      return `
    <div class="card-row card-row-edit">
      <div class="card-edit-fields">
        <div class="field"><label>Front</label><textarea id="edit-front" onkeydown="if(event.key==='Escape'){event.preventDefault();cancelCardEdit();}">${escapeHtml(c.front)}</textarea></div>
        <div class="field"><label>Back</label><textarea id="edit-back" onkeydown="if(event.key==='Escape'){event.preventDefault();cancelCardEdit();}">${escapeHtml(c.back)}</textarea></div>
      </div>
      <div class="card-edit-actions">
        <button class="btn btn-ghost btn-sm" onclick="cancelCardEdit()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="onSaveCardEdit('${c.id}')">Save</button>
      </div>
    </div>`;
    }
    return `
    <div class="card-row" data-card-id="${c.id}">
      <div><div class="lbl">Front</div><div class="front">${escapeHtml(c.front)}</div></div>
      <div><div class="lbl">Back</div><div class="back">${escapeHtml(c.back)}</div></div>
      <div class="card-row-actions">
        <button class="btn-edit-ghost" title="Edit card" onclick="startCardEdit('${c.id}')">Edit</button>
        <button class="btn-danger-ghost" title="Delete card" onclick="onDeleteCard('${c.id}')">Delete</button>
      </div>
    </div>`;
  }).join('');
}

function onAddCard() {
  const front = document.getElementById('card-front').value.trim();
  const back = document.getElementById('card-back').value.trim();
  const err = document.getElementById('card-error');
  if (!front || !back) { err.textContent = 'Both the front and the back are required.'; return; }
  err.textContent = '';
  addCard(currentDeckId, front, back);
  document.getElementById('card-front').value = '';
  document.getElementById('card-back').value = '';
  document.getElementById('card-front').focus();
  renderCards();
  toast('Card added');
}

function onDeleteCard(cardId) { deleteCard(cardId); renderCards(); }

/* Inline card editing: one card at a time, tracked by editingCardId. */
function startCardEdit(cardId) {
  editingCardId = cardId;
  renderCards();
  const el = document.getElementById('edit-front');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}
function cancelCardEdit() {
  editingCardId = null;
  renderCards();
}
function onSaveCardEdit(cardId) {
  const front = document.getElementById('edit-front').value.trim();
  const back = document.getElementById('edit-back').value.trim();
  if (!front || !back) { toast('Front and back are both required'); return; }
  updateCard(cardId, front, back);
  editingCardId = null;
  renderCards();
  toast('Card updated');
}

function onDeleteDeck() {
  const deck = getDeck(currentDeckId);
  if (!deck) return;
  const count = cardsForDeck(currentDeckId).length;
  const msg = count > 0
    ? `Delete "${deck.name}" and its ${count} card${count === 1 ? '' : 's'}? This can't be undone.`
    : `Delete "${deck.name}"?`;
  if (!confirm(msg)) return;
  deleteDeck(currentDeckId);
  toast('Deck deleted');
  goDecks();
}

/* ----------------------------------------------------------------
   7. REVIEW (SM-2)
   ----------------------------------------------------------------
   reviewQueue holds card IDs for this session. Rating "Again" pushes
   the card back onto the end so you see it again before you finish.
   We always re-read the card's srs from storage before scheduling, so
   the saved state stays the source of truth. */

let reviewQueue = [];
let reviewPos = 0;
let isFlipped = false;
let stats = { again: 0, hard: 0, good: 0, easy: 0 };

function startReview(studyAll = false) {
  const pool = studyAll ? cardsForDeck(currentDeckId) : dueCards(currentDeckId);
  const deck = getDeck(currentDeckId);

  document.getElementById('review-active').style.display = 'none';
  document.getElementById('review-done').style.display = 'none';
  document.getElementById('review-caughtup').style.display = 'none';
  setActiveTab(null);

  if (pool.length === 0) {
    // Nothing due. Offer to study ahead (if there are any cards at all).
    const total = cardsForDeck(currentDeckId).length;
    document.getElementById('caughtup-text').textContent = total > 0
      ? "No cards are due in this deck right now. Come back later, or study ahead."
      : "This deck has no cards yet. Add some first.";
    document.getElementById('study-ahead-btn').style.display = total > 0 ? '' : 'none';
    document.getElementById('review-caughtup').style.display = 'block';
    setCrumb(deck ? deck.name : '');
    showScreen('review');
    return;
  }

  reviewQueue = pool.map(c => c.id);
  reviewPos = 0;
  isFlipped = false;
  stats = { again: 0, hard: 0, good: 0, easy: 0 };
  document.getElementById('review-deck-name').textContent = deck ? deck.name : '';
  document.getElementById('review-active').style.display = 'block';
  setCrumb(deck ? deck.name + ' · studying' : 'studying');
  renderReview();
  showScreen('review');
}

function currentReviewCard() { return getCard(reviewQueue[reviewPos]); }

function renderReview() {
  const card = currentReviewCard();
  if (!card) { finishReview(); return; }
  const total = reviewQueue.length;

  document.getElementById('review-pos').textContent = (reviewPos + 1) + ' / ' + total;
  document.getElementById('review-bar').style.width = Math.round(reviewPos / total * 100) + '%';
  document.getElementById('face-label').textContent = isFlipped ? 'Answer' : 'Question';
  document.getElementById('face-text').textContent = isFlipped ? card.back : card.front;
  document.getElementById('flip-hint').style.display = isFlipped ? 'none' : 'block';
  document.getElementById('show-answer-row').style.display = isFlipped ? 'none' : 'flex';
  document.getElementById('rating-grid').style.display = isFlipped ? 'grid' : 'none';

  if (isFlipped) {
    document.getElementById('iv-again').textContent = previewLabel(card.srs, 'again');
    document.getElementById('iv-hard').textContent  = previewLabel(card.srs, 'hard');
    document.getElementById('iv-good').textContent  = previewLabel(card.srs, 'good');
    document.getElementById('iv-easy').textContent  = previewLabel(card.srs, 'easy');
  }

  autoSpeakReview();
}

function flip() { if (!isFlipped) { isFlipped = true; renderReview(); } }

function rate(rating) {
  const card = currentReviewCard();
  if (!card) return;
  updateCardSrs(card.id, schedule(card.srs, rating));
  logReview();               // record that a review happened today (for streaks + calendar)
  stats[rating]++;
  if (rating === 'again') reviewQueue.push(card.id);  // see it again this session
  reviewPos++;
  isFlipped = false;
  if (reviewPos >= reviewQueue.length) finishReview();
  else renderReview();
}

function finishReview() {
  const reviewed = stats.again + stats.hard + stats.good + stats.easy;
  document.getElementById('done-text').textContent =
    `You reviewed ${reviewed} card${reviewed === 1 ? '' : 's'}. Scheduling updated.`;
  document.getElementById('cnt-again').textContent = stats.again;
  document.getElementById('cnt-hard').textContent = stats.hard;
  document.getElementById('cnt-good').textContent = stats.good;
  document.getElementById('cnt-easy').textContent = stats.easy;
  document.getElementById('review-active').style.display = 'none';
  document.getElementById('review-caughtup').style.display = 'none';
  document.getElementById('review-done').style.display = 'block';
  renderSessionReward('review-reward');
  const deck = getDeck(currentDeckId);
  setCrumb(deck ? deck.name : '');
}

/* Keyboard: Space/Enter flips; 1-4 rate once flipped; Esc exits. */
document.addEventListener('keydown', e => {
  const reviewing = document.getElementById('screen-review').classList.contains('active')
    && document.getElementById('review-active').style.display !== 'none';
  if (!reviewing) return;
  if (e.key === 's' || e.key === 'S') { e.preventDefault(); speakReviewFace(); return; }
  if (!isFlipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(); return; }
  if (isFlipped) {
    if (e.key === '1') rate('again');
    else if (e.key === '2') rate('hard');
    else if (e.key === '3') rate('good');
    else if (e.key === '4') rate('easy');
  }
  if (e.key === 'Escape') goDeck(currentDeckId);
});
document.getElementById('flashcard').addEventListener('keydown', e => {
  if (!isFlipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); flip(); }
});

/* ----------------------------------------------------------------
   7B. QUIZ (multiple choice)
   ----------------------------------------------------------------
   A different way to study the same cards: recognition instead of
   recall. Each question shows a card's front; the options are that
   card's back (correct) plus a few other cards' backs (distractors),
   all from the same deck — so no AI and no network. Needs ≥ 4 cards.
   Quiz is a self-test: it does NOT change the SM-2 schedule, but each
   answer counts toward your streak (it's still studying). */

const QUIZ_MIN = 4;       // fewest cards a deck needs to build a quiz
const QUIZ_MAX = 20;      // cap questions so a session stays short
const QUIZ_OPTIONS = 4;   // options per question: 1 correct + up to 3 distractors

let quizQuestions = [];
let quizPos = 0;
let quizScore = 0;
let quizAnswered = false;

/* Fisher–Yates shuffle — returns a new array, doesn't mutate the input. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQuiz(cards) {
  const chosen = shuffle(cards).slice(0, QUIZ_MAX);
  return chosen.map(card => {
    // Distractors = other cards' backs, minus any equal to the answer, deduped.
    const pool = [...new Set(
      cards.filter(c => c.id !== card.id)
           .map(c => c.back)
           .filter(b => b.trim() && b.trim() !== card.back.trim())
    )];
    const distractors = shuffle(pool).slice(0, QUIZ_OPTIONS - 1);
    return { front: card.front, correct: card.back, options: shuffle([card.back, ...distractors]) };
  });
}

function startQuiz() {
  const cards = cardsForDeck(currentDeckId);
  if (cards.length < QUIZ_MIN) { toast(`Add at least ${QUIZ_MIN} cards to quiz this deck`); return; }
  const deck = getDeck(currentDeckId);

  quizQuestions = buildQuiz(cards);
  quizPos = 0;
  quizScore = 0;
  quizAnswered = false;

  document.getElementById('quiz-done').style.display = 'none';
  document.getElementById('quiz-active').style.display = 'block';
  document.getElementById('quiz-deck-name').textContent = deck ? deck.name : '';
  setActiveTab(null);
  setCrumb(deck ? deck.name + ' · quiz' : 'quiz');
  renderQuiz();
  showScreen('quiz');
}

function renderQuiz() {
  const q = quizQuestions[quizPos];
  if (!q) { finishQuiz(); return; }
  const total = quizQuestions.length;
  quizAnswered = false;

  document.getElementById('quiz-pos').textContent = (quizPos + 1) + ' / ' + total;
  document.getElementById('quiz-bar').style.width = Math.round(quizPos / total * 100) + '%';
  document.getElementById('quiz-q-text').textContent = q.front;
  const fb = document.getElementById('quiz-feedback');
  fb.textContent = ''; fb.className = 'quiz-feedback';
  document.getElementById('quiz-next-btn').style.display = 'none';

  document.getElementById('quiz-options').innerHTML = q.options.map((opt, i) => `
    <button class="quiz-option" onclick="answerQuiz(${i})">
      <span class="kbd">${i + 1}</span><span>${escapeHtml(opt)}</span>
    </button>`).join('');
}

function answerQuiz(i) {
  if (quizAnswered) return;
  quizAnswered = true;
  const q = quizQuestions[quizPos];
  const picked = q.options[i];
  const isRight = picked.trim() === q.correct.trim();

  logReview();  // a quiz answer is a study rep — count it toward the streak

  document.querySelectorAll('#quiz-options .quiz-option').forEach((btn, idx) => {
    btn.disabled = true;
    if (q.options[idx].trim() === q.correct.trim()) btn.classList.add('correct');
    else if (idx === i) btn.classList.add('wrong');
  });

  const fb = document.getElementById('quiz-feedback');
  if (isRight) { quizScore++; fb.textContent = 'Correct'; fb.className = 'quiz-feedback right'; }
  else { fb.textContent = 'Not quite'; fb.className = 'quiz-feedback wrong'; }

  const nextBtn = document.getElementById('quiz-next-btn');
  nextBtn.textContent = quizPos + 1 >= quizQuestions.length ? 'See results' : 'Next';
  nextBtn.style.display = '';
  nextBtn.focus();
}

function nextQuiz() {
  quizPos++;
  if (quizPos >= quizQuestions.length) finishQuiz();
  else renderQuiz();
}

function finishQuiz() {
  const total = quizQuestions.length;
  const pct = total ? Math.round(quizScore / total * 100) : 0;
  document.getElementById('quiz-active').style.display = 'none';
  document.getElementById('quiz-done').style.display = 'block';
  renderSessionReward('quiz-reward');
  document.getElementById('quiz-score-title').textContent = `You scored ${quizScore} / ${total}`;
  document.getElementById('quiz-score-text').textContent =
    pct >= 80 ? `${pct}% — strong. These are close to locked in.`
    : pct >= 50 ? `${pct}% — decent. Worth another round.`
    : `${pct}% — early days. Study the deck, then retry.`;
  const deck = getDeck(currentDeckId);
  setCrumb(deck ? deck.name : '');
}

/* Keyboard: 1–4 pick an option; Enter/Space advances; Esc exits. */
document.addEventListener('keydown', e => {
  const quizzing = document.getElementById('screen-quiz').classList.contains('active')
    && document.getElementById('quiz-active').style.display !== 'none';
  if (!quizzing) return;
  if (!quizAnswered && ['1', '2', '3', '4'].includes(e.key)) {
    const btns = document.querySelectorAll('#quiz-options .quiz-option');
    if (btns[Number(e.key) - 1]) answerQuiz(Number(e.key) - 1);
  } else if (quizAnswered && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault(); nextQuiz();
  } else if (e.key === 'Escape') {
    goDeck(currentDeckId);
  }
});

/* ----------------------------------------------------------------
   7C. CRAM (whole deck, schedule ignored)
   ----------------------------------------------------------------
   The night-before-a-test mode: every card in the deck, shuffled,
   until each one has been recalled once. Missed cards go to the back
   of the queue and come around again. Like Quiz, cram never touches
   the SM-2 schedule (a rep 3 minutes after the last one says nothing
   about long-term memory) — but every answer logs toward the streak. */

/* ── 7C-pure. Cram session logic (no DOM) ── */

function buildCramQueue(cards) {
  return shuffle(cards.map(c => c.id));
}

/* One answer → a NEW state (never mutates). Missing a card requeues it at the end. */
function cramAnswer(state, gotIt) {
  const queue = gotIt ? state.queue : [...state.queue, state.queue[state.pos]];
  return { queue, pos: state.pos + 1, misses: state.misses + (gotIt ? 0 : 1) };
}

function cramRemaining(state) { return state.queue.length - state.pos; }
function cramDone(state) { return state.pos >= state.queue.length; }

/* ── 7C-ui. Cram screen ── */

let cramState = null;
let cramFlipped = false;

/* `cardIds` (feature #20) lets "Drill weak spots" cram an explicit set that can
   span decks. Omitted = the current deck, exactly as before. */
function startCram(cardIds) {
  const drilling = Array.isArray(cardIds) && cardIds.length > 0;
  const cards = drilling
    ? cardIds.map(getCard).filter(Boolean)
    : cardsForDeck(currentDeckId);
  if (cards.length === 0) { toast('Add cards before cramming'); return; }
  const deck = getDeck(currentDeckId);
  const label = drilling ? 'Weak spots' : (deck ? deck.name : '');

  cramState = { queue: buildCramQueue(cards), pos: 0, misses: 0 };
  cramFlipped = false;
  document.getElementById('cram-done').style.display = 'none';
  document.getElementById('cram-active').style.display = 'block';
  document.getElementById('cram-deck-name').textContent = label;
  setActiveTab(null);
  setCrumb(label ? label + ' · cramming' : 'cramming');
  // Remembered so "Cram again" repeats the same set — without this, finishing a
  // weak-spots drill and clicking it would quietly cram the last deck instead.
  cramCardIds = drilling ? cardIds : null;
  renderCram();
  showScreen('cram');
}

let cramCardIds = null;
function cramAgain() { startCram(cramCardIds); }

function currentCramCard() { return getCard(cramState.queue[cramState.pos]); }

function renderCram() {
  if (cramDone(cramState)) { finishCram(); return; }
  const card = currentCramCard();
  if (!card) {   // card deleted mid-session — skip it, don't crash
    cramState = { ...cramState, pos: cramState.pos + 1 };
    renderCram();
    return;
  }
  document.getElementById('cram-left').textContent =
    cramRemaining(cramState) + ' left';
  document.getElementById('cram-bar').style.width =
    Math.round(cramState.pos / cramState.queue.length * 100) + '%';
  document.getElementById('cram-face-label').textContent = cramFlipped ? 'Answer' : 'Question';
  document.getElementById('cram-face-text').textContent = cramFlipped ? card.back : card.front;
  document.getElementById('cram-flip-hint').style.display = cramFlipped ? 'none' : 'block';
  document.getElementById('cram-show-row').style.display = cramFlipped ? 'none' : 'flex';
  document.getElementById('cram-grid').style.display = cramFlipped ? 'grid' : 'none';

  autoSpeakCram();
}

function cramFlip() { if (!cramFlipped) { cramFlipped = true; renderCram(); } }

function onCramAnswer(gotIt) {
  if (!cramFlipped) return;
  logReview();   // cramming is studying — it feeds the streak and calendar
  cramState = cramAnswer(cramState, gotIt);
  cramFlipped = false;
  renderCram();
}

function finishCram() {
  const uniqueCards = new Set(cramState.queue).size;
  document.getElementById('cram-active').style.display = 'none';
  document.getElementById('cram-done').style.display = 'block';
  renderSessionReward('cram-reward');
  document.getElementById('cram-score-title').textContent =
    `Deck crammed — ${uniqueCards} card${uniqueCards === 1 ? '' : 's'}`;
  document.getElementById('cram-score-text').textContent = cramState.misses === 0
    ? 'Clean run — no misses. You know this deck.'
    : `You missed ${cramState.misses} time${cramState.misses === 1 ? '' : 's'} along the way — those cards kept coming back until you got them.`;
  const deck = getDeck(currentDeckId);
  setCrumb(deck ? deck.name : '');
}

/* Keyboard: Space/Enter flips; 1 = Missed, 2 = Got it; Esc exits. */
document.addEventListener('keydown', e => {
  const cramming = document.getElementById('screen-cram').classList.contains('active')
    && document.getElementById('cram-active').style.display !== 'none';
  if (!cramming) return;
  if (e.key === 's' || e.key === 'S') { e.preventDefault(); speakCramFace(); return; }
  if (!cramFlipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); cramFlip(); return; }
  if (cramFlipped) {
    if (e.key === '1') onCramAnswer(false);
    else if (e.key === '2') onCramAnswer(true);
  }
  if (e.key === 'Escape') goDeck(currentDeckId);
});

/* ----------------------------------------------------------------
   8. API KEY (browser-direct to Claude)
   ---------------------------------------------------------------- */

const KEY_STORAGE = 'recall.anthropicKey';
function getApiKey() { return localStorage.getItem(KEY_STORAGE) || ''; }

function openKeyModal() {
  document.getElementById('key-input').value = getApiKey();
  document.getElementById('key-error').textContent = '';
  document.getElementById('server-input').value = localStorage.getItem(SERVER_URL_KEY) || '';
  document.getElementById('server-error').textContent = '';
  document.getElementById('gcal-client-input').value = getGCalClientId();
  document.getElementById('gcal-client-error').textContent = '';
  // Which code am I actually running? A waiting service worker cannot activate while
  // any tab is still open, so "I pushed the fix" and "I am running the fix" are not
  // the same statement. This makes the difference visible instead of silent.
  const buildLine = document.getElementById('build-id-line');
  buildLine.textContent =
    currentBuildId ? 'Version ' + currentBuildId : 'Version — not installed (running from the network)';
  // Offline readiness, filled in asynchronously. A precache that failed leaves the app
  // looking healthy and only the audio missing, so the shortfall has to be stated.
  if (currentBuildId) {
    countCachedEntries().then(cached => {
      if (cached === null) return;
      const s = cacheStatus(cached, expectedCacheEntries);
      buildLine.textContent = 'Version ' + currentBuildId + ' · ' + s.text;
      buildLine.classList.toggle('field-hint-warn', !s.ready);
    });
  }
  document.getElementById('key-modal').classList.add('open');
  setTimeout(() => document.getElementById('key-input').focus(), 50);
}
function closeKeyModal() { document.getElementById('key-modal').classList.remove('open'); }

function onSaveKey() {
  // The server address is saved independently of the key: wanting your decks backed
  // up does not mean wanting AI generation, and the key is no longer the only thing
  // this modal holds.
  const rawServer = document.getElementById('server-input').value;
  const change = serverUrlChange(rawServer, localStorage.getItem(SERVER_URL_KEY));
  if (change.action === 'error') {
    document.getElementById('server-error').textContent = change.notice;
    return;
  }
  if (change.action === 'set')    localStorage.setItem(SERVER_URL_KEY, change.url);
  if (change.action === 'remove') localStorage.removeItem(SERVER_URL_KEY);
  document.getElementById('server-error').textContent = '';

  // Saved independently of both the key and the server, for the same reason they are
  // independent of each other: wanting calendar sync implies nothing about the others.
  // Validated only for the shape Google actually issues — a wrong value here fails at
  // Connect with an unreadable Google error, which is a bad place to learn about a typo.
  const rawClient = document.getElementById('gcal-client-input').value.trim();
  if (rawClient && !rawClient.endsWith('.apps.googleusercontent.com')) {
    document.getElementById('gcal-client-error').textContent =
      'That doesn\'t look like a Google client ID (should end with .apps.googleusercontent.com).';
    return;
  }
  if (rawClient) localStorage.setItem(GCAL_CLIENT_ID_KEY, rawClient);
  else localStorage.removeItem(GCAL_CLIENT_ID_KEY);
  document.getElementById('gcal-client-error').textContent = '';

  const k = document.getElementById('key-input').value.trim();
  if (k && !k.startsWith('sk-ant-')) {
    document.getElementById('key-error').textContent = 'That doesn\'t look like an Anthropic key (should start with sk-ant-).';
    return;
  }
  if (k) localStorage.setItem(KEY_STORAGE, k);

  closeKeyModal();
  renderBackupNudge();
  renderGCalPanel();
  // Turning backups off is announced, never silent — the notice wins over the generic
  // confirmation, because it is the one thing here worth noticing.
  toast(change.notice || 'Settings saved');
}
function onClearKey() {
  localStorage.removeItem(KEY_STORAGE);
  document.getElementById('key-input').value = '';
  toast('Key removed');
  closeKeyModal();
}

/* ----------------------------------------------------------------
   8B. API ERROR MAPPING (feature #22) — pure
   ----------------------------------------------------------------
   One mapping for every Claude call. It exists because the same
   401/429/!ok block was copy-pasted at SEVEN call sites, which is
   exactly why 529 — "overloaded", the failure you actually hit in the
   real world — was handled at none of them.

   `retryable` is the important half: it decides whether the UI offers a
   Retry button or tells you to go fix something. Offering to retry a
   rejected API key would be a lie. */

const API_RETRYABLE_STATUS = [408, 429, 500, 502, 503, 504, 529];

const API_MESSAGES = {
  0:   'Could not reach Claude. Check your internet connection and try again.',
  400: 'Claude rejected the request.',
  401: 'Your API key was rejected. Check it in settings (the gear icon).',
  403: 'Your API key does not have permission for this. Check it in settings (the gear icon).',
  408: 'The request to Claude timed out.',
  429: 'Rate limited by the API. Wait a moment and try again.',
  500: 'Claude had a server error. Nothing is wrong on your side.',
  502: 'Claude had a server error. Nothing is wrong on your side.',
  503: 'Claude is temporarily unavailable. Nothing is wrong on your side.',
  504: 'Claude took too long to respond.',
  529: 'Claude is overloaded right now. This is temporary — try again in a moment.'
};

function describeApiError(status, detail) {
  // Pre-flight: navigator.onLine already told us there is no connection, so we
  // can say so precisely instead of guessing from a failed fetch. Retryable by
  // definition — reconnecting IS the fix.
  if (status === 'offline') {
    return { message: 'You appear to be offline. Reconnect and try again.', retryable: true };
  }

  const code = Number(status) || 0;   // undefined / null / 0 all mean "never got a response"

  let message = API_MESSAGES[code];
  if (!message) {
    // Unknown code: 5xx is treated as transient, 4xx as our problem to fix.
    message = code >= 500
      ? 'Claude had a server error (' + code + '). Nothing is wrong on your side.'
      : 'Claude rejected the request (' + code + ').';
  }

  const retryable = API_RETRYABLE_STATUS.includes(code) || (code === 0) || (code >= 500);

  const extra = (typeof detail === 'string') ? detail.trim() : '';
  if (extra) message = message.replace(/[.!]$/, '') + ' — ' + extra.replace(/[.!]+$/, '') + '.';

  return { message, retryable };
}

/* One status line for all five artifacts (feature #22). Was five identical
   copies — which is how the whole app ended up with no Retry button anywhere:
   improving one would have reached only one.

   `retry` is a function, not a boolean. It is passed only when the failure is
   actually retryable, so a rejected API key never gets a Retry button that
   cannot help. Stored on the element rather than serialised into an onclick
   attribute — closures survive; escaped strings in attributes do not. */
function setArtStatus(elId, msg, kind, retry) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = 'gen-status' + (kind === 'error' ? ' error' : '');

  if (kind === 'busy') {
    el.innerHTML = `<span class="spinner"></span> ${escapeHtml(msg)}`;
    return;
  }
  if (kind === 'error' && typeof retry === 'function') {
    el.innerHTML = `<span class="status-msg">${escapeHtml(msg)}</span>` +
      `<button class="btn btn-outline btn-sm status-retry" type="button">Try again</button>`;
    el.querySelector('.status-retry').onclick = retry;
    return;
  }
  el.textContent = msg || '';
}

/* An honest refusal is correct behaviour — "this material has no numbers" beats
   an invented chart. But a refusal with nothing after it is a dead end, so each
   one names what the MATERIAL lacks (not what the app failed at) and points at
   an artifact that does not need it.

   The sheet is the fallback everything else points to: it works on any material,
   so it has nowhere left to send you. */
const ARTIFACT_LABELS = {
  table: 'Table', chart: 'Chart', map: 'Map', timeline: 'Timeline', sheet: 'Sheet'
};

const REFUSAL_HELP = {
  table:    { needs: 'two or more things worth setting side by side',
              alternatives: ['sheet', 'map'] },
  chart:    { needs: 'numbers or quantities to plot',
              alternatives: ['timeline', 'sheet'] },
  map:      { needs: 'concepts that clearly relate to one another',
              alternatives: ['sheet', 'table'] },
  timeline: { needs: 'events or steps that happen in an order',
              alternatives: ['map', 'sheet'] },
  sheet:    { needs: 'enough material to summarise',
              alternatives: [] }
};

function refusalHelp(kind) {
  const entry = REFUSAL_HELP[kind] || { needs: 'material this artifact can work from', alternatives: ['sheet'] };
  return {
    needs: entry.needs,
    alternatives: entry.alternatives
      .filter(k => k !== kind)
      .map(k => ({ key: k, label: ARTIFACT_LABELS[k] || k }))
  };
}

/* ── 8B-impure ───────────────────────────────────────────────────
   Turns a fetch Response into a thrown Error carrying `.retryable`, so
   every call site fails the same way and the UI can decide what to offer. */
async function apiError(res) {
  let detail = '';
  try { const b = await res.json(); detail = b.error?.message || ''; } catch (e) {}
  const { message, retryable } = describeApiError(res.status, detail);
  const err = new Error(message);
  err.retryable = retryable;
  err.status = res.status;
  return err;
}

/* A refusal is not an error: quiet ink, no Retry (retrying cannot change what
   the material contains), but a way forward. */
function setArtRefusal(elId, kind, reason) {
  const el = document.getElementById(elId);
  if (!el) return;
  const help = refusalHelp(kind);
  el.className = 'gen-status note';

  const alts = help.alternatives.length
    ? `<div class="refusal-alts"><span>Try instead:</span>` +
      help.alternatives.map(a =>
        `<button class="btn btn-outline btn-sm" type="button" data-tab="${a.key}">${escapeHtml(a.label)}</button>`
      ).join('') + `</div>`
    : '';

  el.innerHTML =
    `<div class="refusal-why">${escapeHtml(reason)}</div>` +
    `<div class="refusal-needs">A ${escapeHtml(ARTIFACT_LABELS[kind] || kind)} needs ${escapeHtml(help.needs)}. ` +
    `Importing richer material into this deck would also fix it.</div>` + alts;

  el.querySelectorAll('[data-tab]').forEach(b => {
    b.onclick = () => showArtifactTab(b.getAttribute('data-tab'));
  });
}

/* Pre-flight guard: the browser already knows there is no connection.
   Duplicated at seven call sites as a bare `throw new Error(...)` with no
   retryable flag, which is why the offline path showed no Try again button.
   Same duplication bug as the response handling, one layer earlier. */
function offlineError() {
  const { message, retryable } = describeApiError('offline');
  const err = new Error(message);
  err.retryable = retryable;
  return err;
}

/* A response arrived but could not be used — malformed JSON, no text block.
   Retryable: the model is non-deterministic, so the next attempt may well parse.
   Distinct from a REFUSAL, where retrying changes nothing because the material
   itself is the problem. */
function transientError(message) {
  const err = new Error(message);
  err.retryable = true;
  return err;
}

/* A failure before any response existed (DNS, offline, CORS). */
function networkError() {
  const { message, retryable } = describeApiError(0);
  const err = new Error(message);
  err.retryable = retryable;
  return err;
}

/* ----------------------------------------------------------------
   9. GENERATE (Claude API, structured output)
   ---------------------------------------------------------------- */

let genCount = 10;
let generated = [];        // [{front, back}]
let generatedSummary = ''; // AI summary of the source, saved onto the deck with the cards
let generatedSource = '';  // the source text itself, saved onto the deck so Chat can use it
let genTargetDeckId = null; // if set when arriving, preselect this deck
let pdfDoc = null;          // loaded pdf.js document, kept so page re-extraction skips re-reading the file
let pdfName = '';           // filename, for the status line
const MAX_SOURCE_CHARS = 15000; // cap on text sent to Claude in one call (~6–8 dense pages)

/* Schema that forces Claude to return a clean summary + {front, back} objects. */
const CARD_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          front: { type: 'string' },
          back: { type: 'string' }
        },
        required: ['front', 'back'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'cards'],
  additionalProperties: false
};

/* Claude's parsed JSON → clean { cards, summary }. Malformed cards are dropped;
   a missing or garbage summary becomes '' — a bad summary must never block good cards. */
function parseGenResponse(parsed) {
  const rawCards = (parsed && Array.isArray(parsed.cards)) ? parsed.cards : [];
  const cards = rawCards.filter(c => c && c.front && c.back);
  const summary = (parsed && typeof parsed.summary === 'string') ? parsed.summary.trim() : '';
  return { cards, summary };
}

function goGenerate() {
  genTargetDeckId = null;
  enterGenerate();
}
function goGenerateForDeck() {
  genTargetDeckId = currentDeckId;
  enterGenerate();
}

function enterGenerate() {
  setActiveTab('generate');
  setCrumb('');
  populateGenDeckSelect();
  document.getElementById('gen-source').value = '';
  document.getElementById('gen-status').textContent = '';
  document.getElementById('gen-status').className = 'gen-status';
  document.getElementById('gen-results').style.display = 'none';
  generated = [];
  generatedSummary = '';
  generatedSource = '';
  resetPdfImport();
  showScreen('generate');
}

function populateGenDeckSelect() {
  const sel = document.getElementById('gen-deck');
  const decks = [...loadData().decks].sort((a, b) => b.createdAt - a.createdAt);
  let opts = decks.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  opts += `<option value="__new__">➕ New deck…</option>`;
  sel.innerHTML = opts;
  // Preselect: the deck we came from, else first existing, else "new".
  if (genTargetDeckId && decks.some(d => d.id === genTargetDeckId)) sel.value = genTargetDeckId;
  else if (decks.length === 0) sel.value = '__new__';
  onGenDeckChange();
}
function onGenDeckChange() {
  const isNew = document.getElementById('gen-deck').value === '__new__';
  document.getElementById('gen-newdeck-field').style.display = isNew ? 'flex' : 'none';
}

function setCount(btn, n) {
  genCount = n;
  document.querySelectorAll('.count-pill').forEach(p => p.classList.remove('active'));
  btn.classList.add('active');
}

// ── PDF import ──────────────────────────────────────────────────────────
// Two pure helpers (no browser) so they can be unit-tested in Node.

// "" / "all" → every page. "3-8" → [3..8]. "5" → [5]. Validates against the real
// page count and clamps an over-long tail ("3-999" on a 10-page PDF → pages 3–10).
function parsePageRange(input, totalPages) {
  const s = (input || '').trim().toLowerCase();
  if (s === '' || s === 'all') return { pages: rangeArray(1, totalPages) };
  const m = s.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
  if (!m) return { error: 'Pages should look like "3-8" or a single number.' };
  let start = parseInt(m[1], 10);
  let end = m[2] ? parseInt(m[2], 10) : start;
  if (start < 1 || end < 1) return { error: 'Page numbers start at 1.' };
  if (start > end) [start, end] = [end, start];
  if (start > totalPages) return { error: `This PDF only has ${totalPages} page${totalPages === 1 ? '' : 's'}.` };
  if (end > totalPages) end = totalPages; // "3-999" just means "3 to the end"
  return { pages: rangeArray(start, end) };
}
function rangeArray(a, b) { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; }

// The A-backstop: keep the first MAX_SOURCE_CHARS characters. Reports whether it cut.
function capSource(text) {
  if (text.length <= MAX_SOURCE_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_SOURCE_CHARS), truncated: true };
}

function pdfErrorMessage(err) {
  const name = err && err.name;
  if (name === 'PasswordException') return 'This PDF is locked with a password — Recall can’t read it.';
  if (name === 'InvalidPDFException') return 'Couldn’t read that file. Is it a valid PDF?';
  return 'Couldn’t read that PDF. Try another file.';
}

async function onPdfChosen(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = ''; // reset so picking the same file again still fires onchange
  if (!file) return;

  const info = document.getElementById('pdf-info');
  info.className = 'pdf-info';

  if (typeof pdfjsLib === 'undefined') {
    info.className = 'pdf-info error';
    info.textContent = 'PDF reader didn’t load — check your connection and refresh.';
    return;
  }

  info.textContent = 'Reading PDF…';
  try {
    const buf = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
    pdfName = file.name;
    document.getElementById('pdf-pages').value = '';
    document.getElementById('pdf-pages-field').style.display = 'flex';
    await extractIntoSource(''); // all pages by default
  } catch (err) {
    pdfDoc = null;
    document.getElementById('pdf-pages-field').style.display = 'none';
    info.className = 'pdf-info error';
    info.textContent = pdfErrorMessage(err);
  }
}

async function onApplyPdfPages() {
  if (!pdfDoc) return;
  await extractIntoSource(document.getElementById('pdf-pages').value);
}

async function extractIntoSource(rangeInput) {
  const info = document.getElementById('pdf-info');
  const parsed = parsePageRange(rangeInput, pdfDoc.numPages);
  if (parsed.error) { info.className = 'pdf-info error'; info.textContent = parsed.error; return; }

  info.className = 'pdf-info';
  info.textContent = `Extracting ${parsed.pages.length} page${parsed.pages.length === 1 ? '' : 's'}…`;

  let text = '';
  for (const n of parsed.pages) {
    const page = await pdfDoc.getPage(n);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n\n';
  }
  text = text.trim();

  if (!text) {
    info.className = 'pdf-info error';
    info.textContent = 'No text found — this looks like a scanned PDF (images, not text). Recall can’t read those yet.';
    return;
  }

  const { text: capped, truncated } = capSource(text);
  document.getElementById('gen-source').value = capped;

  const pagesLabel = `${pdfName} · ${parsed.pages.length} page${parsed.pages.length === 1 ? '' : 's'}`;
  const kb = Math.round(MAX_SOURCE_CHARS / 1000);
  info.textContent = truncated
    ? `${pagesLabel} — long PDF, loaded the first ~${kb}k characters. Narrow the pages above for the rest.`
    : `${pagesLabel} · loaded into the box below.`;
}

function resetPdfImport() {
  pdfDoc = null;
  pdfName = '';
  const info = document.getElementById('pdf-info');
  info.textContent = '';
  info.className = 'pdf-info';
  document.getElementById('pdf-pages-field').style.display = 'none';
  document.getElementById('pdf-pages').value = '';
}

async function onGenerate() {
  const source = document.getElementById('gen-source').value.trim();
  const status = document.getElementById('gen-status');
  status.className = 'gen-status';

  if (!getApiKey()) { openKeyModal(); status.textContent = 'Add your API key first, then generate.'; return; }
  if (source.length < 40) { status.className = 'gen-status error'; status.textContent = 'Paste a bit more text — at least a few sentences.'; return; }

  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  document.getElementById('gen-results').style.display = 'none';
  status.innerHTML = `<span class="spinner"></span> Asking Claude to write up to ${genCount} cards…`;

  try {
    const { cards, summary } = await callClaude(source, genCount);
    generated = cards;
    generatedSummary = summary;
    generatedSource = source;
    status.textContent = '';
    renderGenerated();
  } catch (err) {
    setArtStatus('gen-status', err.message || 'Something went wrong.', 'error',
                 err.retryable ? onGenerate : null);
  } finally {
    btn.disabled = false;
  }
}

async function callClaude(sourceText, count) {
  if (!navigator.onLine) throw offlineError();

  // System prompt = the rules Claude must follow, drawn from Wozniak's
  // "Twenty Rules of Formulating Knowledge" (the basis of good spaced-repetition cards).
  const systemPrompt =
    `You are an expert at writing study flashcards for spaced repetition, ` +
    `following Piotr Wozniak's "Twenty Rules of Formulating Knowledge". ` +
    `Obey these rules for EVERY card:\n` +
    `1. Minimum information: each card tests exactly ONE fact. Never combine two ideas in one card.\n` +
    `2. Keep the answer short — a few words to one sentence at most. The "back" is the single thing to recall, not an explanation. If a reason also matters, make it a separate card.\n` +
    `3. The "front" is a precise question with one unambiguous answer the learner can grade themselves on.\n` +
    `4. Cards must stand alone. NEVER reference the source — no "according to the text", "the passage", "segundo o texto", or anything the learner won't have in front of them later.\n` +
    `5. Avoid interference: do not create near-duplicate cards that test the same idea in slightly different words.\n` +
    `6. No filler, metaphors, or motivational phrasing in the answer — only the testable fact.\n` +
    `7. Write every card in the SAME language as the source material.\n` +
    `8. Skip trivia; cover the most important, testable ideas.\n` +
    `Also write a "summary" of the material: 3-6 plain sentences a student can reread ` +
    `right before a test. Rules: same language as the source; only what the material ` +
    `actually says (no outside knowledge); no meta-talk like "this text discusses" — ` +
    `state the facts themselves.`;

  // User message = just the task and the material to turn into cards.
  // "Up to" (not "exactly") so a thin source yields fewer, distinct cards
  // instead of padding with near-duplicates of the same idea.
  const prompt =
    `Create up to ${count} flashcards AND a short summary from the material below, following all the rules. ` +
    `Make FEWER cards rather than repeating an idea: if the material contains only a handful of distinct facts, return only that many. ` +
    `Distinct, non-overlapping cards matter more than hitting the number.\n\n` +
    `Material:\n${sourceText}`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        output_config: { format: { type: 'json_schema', schema: CARD_SCHEMA } },
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to generate cards from this text.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }

  const result = parseGenResponse(parsed);
  if (result.cards.length === 0) throw new Error('No cards came back. Try different or longer text.');
  return result;
}

function renderGenerated() {
  const wrap = document.getElementById('gen-results');
  document.getElementById('gen-results-title').textContent = `${generated.length} card${generated.length === 1 ? '' : 's'} generated`;
  document.getElementById('gen-save-btn').textContent = `Add ${generated.length} to deck`;
  const sumWrap = document.getElementById('gen-summary');
  sumWrap.style.display = generatedSummary ? 'block' : 'none';
  document.getElementById('gen-summary-text').textContent = generatedSummary;
  const body = document.getElementById('gen-cards-body');
  body.innerHTML = generated.map((c, i) => `
    <div class="card-row">
      <div><div class="lbl">Front</div><div class="front">${escapeHtml(c.front)}</div></div>
      <div><div class="lbl">Back</div><div class="back">${escapeHtml(c.back)}</div></div>
      <button class="btn-danger-ghost" title="Drop this card" onclick="dropGenerated(${i})">Drop</button>
    </div>`).join('');
  wrap.style.display = 'block';
}

function dropGenerated(i) {
  generated.splice(i, 1);
  if (generated.length === 0) { discardGenerated(); toast('All cards discarded'); return; }
  renderGenerated();
}
function discardGenerated() {
  generated = [];
  generatedSummary = '';
  generatedSource = '';
  document.getElementById('gen-results').style.display = 'none';
}

function saveGenerated() {
  if (generated.length === 0) return;
  const sel = document.getElementById('gen-deck');
  let deckId;
  if (sel.value === '__new__') {
    const name = document.getElementById('gen-newdeck-name').value.trim();
    if (!name) { document.getElementById('gen-status').className = 'gen-status error'; document.getElementById('gen-status').textContent = 'Name the new deck first.'; return; }
    deckId = createDeck(name, '').id;
  } else {
    deckId = sel.value;
  }
  generated.forEach(c => addCard(deckId, c.front, c.back));
  if (generatedSummary) updateDeckSummary(deckId, generatedSummary);
  // Cap at save time: the PDF path already caps, but pasted text arrives uncapped.
  if (generatedSource) updateDeckSource(deckId, capSource(generatedSource).text);
  const n = generated.length;
  generated = [];
  generatedSummary = '';
  generatedSource = '';
  toast(`${n} card${n === 1 ? '' : 's'} added`);
  goDeck(deckId);
}

/* ----------------------------------------------------------------
   9B. CHAT WITH MATERIAL (Claude API, free-text output)
   ---------------------------------------------------------------- */

/* ── 9B-pure. Pure helpers (no DOM, no network) — unit-tested by
   "04 System/(C) test-chat.mjs", which slices this block out of the file.
   The block must stay contiguous and self-contained: nothing in it may
   reference a symbol defined elsewhere in app.js. ── */

const CHAT_CONTEXT_MAX = 15000; // same budget as generation (~6–8 dense pages)
const CHAT_HISTORY_MAX = 10;    // messages resent per call (5 exchanges). Even on
                                // purpose: a capped slice of complete user→assistant
                                // exchanges always starts with a 'user' message.

/* Decide what Claude gets to read about this deck.
   The imported source text wins; decks that never stored one (manual decks,
   pre-v3 decks) fall back to summary + flashcards. 'none' → nothing to chat about. */
function buildChatContext(deck, cards) {
  if (!deck) return { text: '', kind: 'none' };
  const source = typeof deck.source === 'string' ? deck.source.trim() : '';
  if (source) return { text: source.slice(0, CHAT_CONTEXT_MAX), kind: 'source' };

  const summary = typeof deck.summary === 'string' ? deck.summary.trim() : '';
  const list = Array.isArray(cards) ? cards.filter(c => c && c.front && c.back) : [];
  if (!summary && list.length === 0) return { text: '', kind: 'none' };

  const parts = [];
  if (summary) parts.push('Summary:\n' + summary);
  if (list.length > 0) parts.push('Flashcards:\n' + list.map(c => `Q: ${c.front}\nA: ${c.back}`).join('\n\n'));
  return { text: parts.join('\n\n').slice(0, CHAT_CONTEXT_MAX), kind: 'cards' };
}

/* Three openers for an empty chat (feature #21, from the original web concept).
   The point is not decoration: facing a blank input you have to invent a
   question for is the reason a chat feature goes unused. */
const CHAT_SUGGESTIONS = [
  'Explain this in simpler terms',
  'Give me a real-world example',
  'Why does this matter?'
];

/* What the chat header says it is grounded in. Returns the pieces rather than a
   finished string so the markup decides the punctuation. */
function chatGrounding(deck, cards, kind) {
  if (!deck) return { deckName: '', basis: '', cardCount: 0 };
  const basis = kind === 'source' ? 'imported material'
              : kind === 'cards'  ? 'cards & summary'
              : '';
  return {
    deckName: deck.name || '',
    basis,
    cardCount: Array.isArray(cards) ? cards.length : 0
  };
}

/* Conversation so far + the new question → the Messages API "messages" array.
   Render-only entries (like error rows) are filtered out, and only the most
   recent CHAT_HISTORY_MAX messages are resent — older turns fall away. */
function buildChatMessages(history, question) {
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-CHAT_HISTORY_MAX)
    .map(m => ({ role: m.role, content: m.text }));
  return [...turns, { role: 'user', content: question }];
}

/* Raw API JSON → { ok, text } or { ok, error }. The gatekeeper between the
   network and the UI — chat's version of parseGenResponse. */
function parseChatResponse(data) {
  if (!data || !Array.isArray(data.content)) return { ok: false, error: 'Claude returned no answer. Try again.' };
  if (data.stop_reason === 'refusal') return { ok: false, error: 'Claude declined to answer that.' };
  const text = data.content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n\n')
    .trim();
  if (!text) return { ok: false, error: 'Claude returned no answer. Try again.' };
  return { ok: true, text };
}

/* ── Chat history that survives leaving the screen (feature #29) ──

   Before this, goChatForDeck() ran `chatHistory = []` on EVERY entry — including
   re-entering the SAME deck. The natural way to use chat (ask, go look at the card
   in Review, come back) was the one way that destroyed the thread.

   A store keyed by deckId, so switching decks and returning costs nothing. All three
   are IMMUTABLE per the vault's coding rule: they return a new object rather than
   editing the one they were handed.

   Deliberately in memory only. Persisting to saveData() would write every exchange
   into localStorage — a bigger change, and the note that logged this asked only for
   survival across in-app navigation, not across reloads. */
function chatHistoryFor(store, deckId) {
  if (!store || !deckId) return [];
  const h = store[deckId];
  // A non-array here means something corrupted the store. Degrade to a fresh thread
  // rather than handing renderChat() something it will crash on.
  return Array.isArray(h) ? h : [];
}

function rememberChat(store, deckId, history) {
  const base = store || {};
  if (!deckId) return base;
  return { ...base, [deckId]: Array.isArray(history) ? history : [] };
}

function forgetChat(store, deckId) {
  const base = store || {};
  if (!deckId || !(deckId in base)) return base;
  const next = { ...base };
  delete next[deckId];
  return next;
}

/* ── 9B-impure. The live call + the chat screen ── */

/* One question → one API call. Uses Sonnet (cheaper + faster than the Opus
   model generation uses — chat is multi-turn, so cost per message matters).
   The deck's material rides in the SYSTEM prompt, rebuilt every call; the
   conversation itself is the messages array. Free-text output — no schema. */
async function callClaudeChat(context, history, question) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You are a study tutor helping a student understand their own material. ` +
    `STRICT RULES:\n` +
    `1. Answer ONLY from the study material below — no outside knowledge, even if you know the answer.\n` +
    `2. If the material does not cover the question, say so plainly — never guess or fill gaps.\n` +
    `3. Answer in the SAME language as the student's question.\n` +
    `4. Be concise: a short direct answer first, then at most a brief explanation drawn from the material.\n` +
    `5. The material may be raw source text, or a summary plus flashcards — treat whichever you get as the full extent of what you know.\n` +
    `6. Answer in PLAIN TEXT only — no markdown symbols (no #, *, **, bullet dashes, or headers). The chat displays raw text, so markdown shows up as literal symbols.\n\n` +
    `Study material:\n${context}`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: buildChatMessages(history, question)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  const r = parseChatResponse(data);
  // An empty/unusable answer is transient — the same question often works again.
  if (!r.ok) throw transientError(r.error);
  return r.text;
}

// Chat threads survive leaving the screen (feature #29), kept per deck for the tab
// session. chatHistory is the thread currently on screen; chatHistoryStore holds it
// for every deck chatted this session. A reload still clears everything, by design.
let chatHistoryStore = {};   // { [deckId]: [{ role, text }] }
let chatHistory = []; // [{ role: 'user' | 'assistant', text }]
let chatErrorRetryable = false;   // only a transient failure gets a Try again button
let chatRetryQuestion = '';       // the question that failed, so Retry resends it
let chatContext = null;
let chatBusy = false;
let chatError = '';

function goChatForDeck() {
  const deck = getDeck(currentDeckId);
  if (!deck) { goDecks(); return; }
  chatContext = buildChatContext(deck, cardsForDeck(currentDeckId));
  if (chatContext.kind === 'none') { toast('Add cards or material before chatting'); return; }

  // Pick the thread back up instead of destroying it. Entering a DIFFERENT deck still
  // starts clean, because the store is keyed by deck — inheriting another deck's
  // conversation would be worse than losing it.
  chatHistory = chatHistoryFor(chatHistoryStore, currentDeckId);
  chatBusy = false;
  chatError = '';
  setCrumb(deck.name + ' · Chat');
  setActiveTab(null);
  const g = chatGrounding(deck, cardsForDeck(currentDeckId), chatContext.kind);
  document.getElementById('chat-source').innerHTML =
    `Grounded in · <strong>${escapeHtml(g.deckName)}</strong> · ${g.basis}` +
    (g.cardCount > 0 ? ` · ${g.cardCount} card${g.cardCount === 1 ? '' : 's'}` : '');
  document.getElementById('chat-input').value = '';
  renderChat();
  showScreen('chat');
  setTimeout(() => document.getElementById('chat-input').focus(), 50);
}

/* An assistant turn, with the "R" mark from the concept. User turns stay a bare
   bubble — the mark is what distinguishes Recall's voice from yours at a glance. */
function assistantMsgHtml(inner, extraClass) {
  return `<div class="msg-ai-wrap">
      <div class="msg-ai-mark" aria-hidden="true">R</div>
      <div class="chat-msg assistant ${extraClass || ''}">${inner}</div>
    </div>`;
}

function renderChat() {
  const thread = document.getElementById('chat-thread');
  let html = '';
  if (chatHistory.length === 0 && !chatBusy && !chatError) {
    html = assistantMsgHtml(
      'I have read this deck’s material. Ask me to explain a concept, give an example, ' +
      'or simplify anything that did not click.');
  } else {
    html = chatHistory.map(m => m.role === 'user'
      ? `<div class="chat-msg user">${escapeHtml(m.text)}</div>`
      : assistantMsgHtml(escapeHtml(m.text))).join('');
    if (chatBusy) html += assistantMsgHtml('<span class="spinner"></span> Thinking…', 'chat-pending');
    if (chatError) {
      html += `<div class="chat-msg error">${escapeHtml(chatError)}` +
        (chatErrorRetryable
          ? `<button class="btn btn-outline btn-sm status-retry" type="button" id="chat-retry">Try again</button>`
          : '') + `</div>`;
    }
  }
  thread.innerHTML = html;

  // Starters only make sense on an empty thread; once you are talking they are noise.
  const sug = document.getElementById('chat-suggestions');
  sug.style.display = (chatHistory.length === 0 && !chatBusy) ? '' : 'none';
  sug.innerHTML = CHAT_SUGGESTIONS.map((s, i) =>
    `<button class="suggestion-btn" onclick="onChatSuggestion(${i})">${escapeHtml(s)}</button>`).join('');

  const retryBtn = document.getElementById('chat-retry');
  if (retryBtn) retryBtn.onclick = onChatRetry;

  document.getElementById('chat-input').disabled = chatBusy;
  document.getElementById('chat-send-btn').disabled = chatBusy;
  thread.scrollTop = thread.scrollHeight;
}

/* Retry after a transient failure: the question was restored to the input when
   it failed, so resending is just sending again. */
function onChatRetry() {
  if (chatBusy) return;
  const input = document.getElementById('chat-input');
  if (!input.value.trim() && chatRetryQuestion) input.value = chatRetryQuestion;
  chatError = '';
  chatErrorRetryable = false;
  onSendChat();
}

/* Index, not text: passing the string through an inline onclick would need
   escaping for quotes and apostrophes, and "Why does this matter?" is one
   apostrophe away from breaking the attribute. */
function onChatSuggestion(i) {
  const text = CHAT_SUGGESTIONS[i];
  if (!text || chatBusy) return;
  document.getElementById('chat-input').value = text;
  onSendChat();
}

async function onSendChat() {
  if (chatBusy) return;
  const input = document.getElementById('chat-input');
  const question = input.value.trim();
  if (!question) return;
  if (!getApiKey()) { openKeyModal(); return; }

  chatHistory = [...chatHistory, { role: 'user', text: question }];
  chatError = '';
  chatErrorRetryable = false;
  input.value = '';
  chatBusy = true;
  chatError = '';
  renderChat();

  try {
    // History = everything BEFORE this question; the question itself goes in separately.
    const answer = await callClaudeChat(chatContext.text, chatHistory.slice(0, -1), question);
    chatHistory = [...chatHistory, { role: 'assistant', text: answer }];
  } catch (err) {
    // Failed exchange: remove the question from history and put it back in the
    // input, so history only ever holds complete user→assistant exchanges.
    chatHistory = chatHistory.slice(0, -1);
    input.value = question;
    chatError = err.message || 'Something went wrong.';
    chatErrorRetryable = !!err.retryable;
    chatRetryQuestion = question;
  } finally {
    chatBusy = false;
    // Persist for the session AFTER the exchange settles, success or failure. On
    // failure chatHistory has already been rolled back to complete exchanges only,
    // so a failed question is never stored and never resent as context later.
    chatHistoryStore = rememberChat(chatHistoryStore, currentDeckId, chatHistory);
    renderChat();
    if (!chatError) input.focus();
  }
}

/* Start over on purpose. The thread now survives navigation, so there has to be a
   deliberate way to end it — otherwise the only escape is reloading the page. */
function onNewConversation() {
  chatHistoryStore = forgetChat(chatHistoryStore, currentDeckId);
  chatHistory = [];
  chatError = '';
  chatErrorRetryable = false;
  chatBusy = false;
  renderChat();
  document.getElementById('chat-input').focus();
}

/* ----------------------------------------------------------------
   9C. COMPARISON TABLE (Claude API, structured output)
   ---------------------------------------------------------------- */

/* ── 9C-pure. Pure helpers (no DOM, no network) — unit-tested by
   "04 System/(C) test-table.mjs", which slices this block out of the file.
   The block must stay contiguous and self-contained: nothing in it may
   reference a symbol defined elsewhere in app.js. ── */

const TABLE_CONTEXT_MAX = 15000; // same budget as generation and chat
const TABLE_COLS_MIN = 2;        // a "comparison" of one thing isn't one
const TABLE_COLS_MAX = 5;        // wider than 5 stops being readable
const TABLE_ROWS_MIN = 3;        // fewer than 3 rows isn't worth a table
const TABLE_ROWS_MAX = 8;        // a study table, not a database dump

/* Decide what Claude gets to read about this deck — same rule as chat:
   the imported source wins; older decks fall back to summary + cards. */
function buildTableContext(deck, cards) {
  if (!deck) return { text: '', kind: 'none' };
  const source = typeof deck.source === 'string' ? deck.source.trim() : '';
  if (source) return { text: source.slice(0, TABLE_CONTEXT_MAX), kind: 'source' };

  const summary = typeof deck.summary === 'string' ? deck.summary.trim() : '';
  const list = Array.isArray(cards) ? cards.filter(c => c && c.front && c.back) : [];
  if (!summary && list.length === 0) return { text: '', kind: 'none' };

  const parts = [];
  if (summary) parts.push('Summary:\n' + summary);
  if (list.length > 0) parts.push('Flashcards:\n' + list.map(c => `Q: ${c.front}\nA: ${c.back}`).join('\n\n'));
  return { text: parts.join('\n\n').slice(0, TABLE_CONTEXT_MAX), kind: 'cards' };
}

/* One user turn: the request (steered or auto-pick) + the material.
   Single-turn call, so there's no history to keep clean. */
function buildTableMessages(contextText, steering) {
  const want = typeof steering === 'string' ? steering.trim() : '';
  const ask = want
    ? `Build a comparison table of: ${want}`
    : `Find the most comparison-worthy concepts in the material and build the comparison table a student would want before a test.`;
  return [{ role: 'user', content: `${ask}\n\nMaterial:\n${contextText}` }];
}

/* Claude's parsed JSON → a clean table or an honest failure. The gatekeeper
   between the network and the UI — the table's parseGenResponse. */
function parseTableResponse(parsed) {
  const malformed = { ok: false, reason: 'malformed', error: 'Claude returned an unusable table. Try again.' };
  if (!parsed || typeof parsed !== 'object') return malformed;

  if (parsed.comparable === false) {
    const why = (typeof parsed.reason === 'string' && parsed.reason.trim())
      ? parsed.reason.trim()
      : 'The material has nothing worth comparing.';
    return { ok: false, reason: 'not_comparable', error: why };
  }

  const rawCols = Array.isArray(parsed.columns) ? parsed.columns : [];
  const colsOk = rawCols.length >= TABLE_COLS_MIN && rawCols.length <= TABLE_COLS_MAX
    && rawCols.every(c => typeof c === 'string' && c.trim());
  if (!colsOk) return malformed;
  const columns = rawCols.map(c => c.trim());

  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter(r => Array.isArray(r) && r.length === columns.length && r.every(c => typeof c === 'string'))
    .map(r => r.map(c => c.trim()))
    .slice(0, TABLE_ROWS_MAX);
  if (rows.length < TABLE_ROWS_MIN) return malformed;

  const title = typeof parsed.title === 'string' ? parsed.title.trim() : '';
  return { ok: true, table: { title, columns, rows } };
}

/* A saved table → CSV text (RFC 4180): header row, then data rows, CRLF
   line endings for Excel. Fields containing quotes, commas or newlines get
   quoted, inner quotes doubled. Garbage in → '' out, never throws. */
function tableToCsv(table) {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return '';
  const field = v => {
    const s = String(v == null ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [table.columns, ...table.rows].map(r => (Array.isArray(r) ? r : []).map(field).join(','));
  return lines.join('\r\n');
}

/* ── 9C-impure. The live call ── */

/* Schema that forces Claude to return either a clean table or an honest
   "not comparable" — the escape hatch means it's never cornered into
   inventing a comparison the material doesn't support. */
const TABLE_SCHEMA = {
  type: 'object',
  properties: {
    comparable: { type: 'boolean' },
    reason: { type: 'string' },
    title: { type: 'string' },
    columns: { type: 'array', items: { type: 'string' } },
    rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
  },
  required: ['comparable', 'reason', 'title', 'columns', 'rows'],
  additionalProperties: false
};

/* One click → one API call. Sonnet, not Opus: this is structured extraction,
   not creative card-writing (same reasoning as chat). Returns the parsed
   result object — "not comparable" is an honest answer, not an exception. */
async function callClaudeTable(contextText, steering) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You build comparison tables that help a student study their own material. ` +
    `STRICT RULES:\n` +
    `1. Compare ONLY what the material supports — no outside knowledge, even if you know more.\n` +
    `2. ${TABLE_COLS_MIN}-${TABLE_COLS_MAX} columns and ${TABLE_ROWS_MIN}-${TABLE_ROWS_MAX} rows. The FIRST column names the thing each row compares.\n` +
    `3. PLAIN TEXT in every cell — no markdown, and no formulas or facts the material doesn't contain.\n` +
    `4. Write in the SAME language as the material.\n` +
    `5. If the user asked for a comparison the material can't support, or nothing in it is worth comparing, set "comparable" to false and put ONE plain sentence in "reason" saying why. Never invent a table.\n` +
    `6. The material may be raw source text, or a summary plus flashcards — treat whichever you get as the full extent of what you know.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema: TABLE_SCHEMA } },
        system: systemPrompt,
        messages: buildTableMessages(contextText, steering)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to build a table from this material.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }
  return parseTableResponse(parsed);
}

/* ── 9C-screen. The table screen ── */

let tableBusy = false;

/* ── Artifacts screen shell: one screen, one tab per artifact kind.
   The 9th deck-row button never happened — Table/Sheet/Map live here. ── */

let currentArtifactTab = 'table';

function goArtifactsForDeck() {
  const deck = getDeck(currentDeckId);
  if (!deck) { goDecks(); return; }
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { toast('Add cards or material before building artifacts'); return; }

  setCrumb(deck.name + ' · Artifacts');
  setActiveTab(null);
  document.getElementById('artifacts-deck-name').textContent = deck.name;
  document.getElementById('artifacts-context-kind').textContent = ctx.kind === 'source'
    ? 'Study artifacts · grounded in your imported material'
    : 'Study artifacts · grounded in this deck’s cards & summary';
  showScreen('artifacts');
  showArtifactTab(currentArtifactTab);
}

function showArtifactTab(kind) {
  currentArtifactTab = kind;
  document.querySelectorAll('.art-tab').forEach(t => t.classList.toggle('active', t.id === 'art-tab-' + kind));
  document.querySelectorAll('.art-panel').forEach(p => { p.style.display = p.id === 'art-panel-' + kind ? '' : 'none'; });
  renderArtifactTabDots();
  if (kind === 'table') prepTableTab();
  else if (kind === 'sheet') prepSheetTab();
  else if (kind === 'map') prepMapTab();
  else if (kind === 'timeline') prepTimelineTab();
  else if (kind === 'chart') prepChartTab();
}

/* Dot marker on tabs whose artifact already exists — what's saved, at a glance. */
function renderArtifactTabDots() {
  const deck = getDeck(currentDeckId);
  const arts = deck ? deck.artifacts : {};
  document.querySelectorAll('.art-tab').forEach(tab => {
    const kind = tab.id.replace('art-tab-', '');
    tab.textContent = kind[0].toUpperCase() + kind.slice(1) + (arts[kind] ? ' ·' : '');
  });
}

function prepTableTab() {
  tableBusy = false;
  document.getElementById('table-steering').value = '';
  setTableStatus('');
  renderTable();
  setTimeout(() => document.getElementById('table-steering').focus(), 50);
}

/* status kinds: '' clears; 'busy' shows the spinner; 'error' goes red;
   'note' is quiet ink for honest non-errors like "not comparable". */
function setTableStatus(msg, kind, retry) { setArtStatus('table-status', msg, kind, retry); }

function renderTable() {
  const deck = getDeck(currentDeckId);
  const wrap = document.getElementById('table-result');
  const a = deck ? deck.artifacts.table : '';
  if (!a || a.type !== 'table') {
    wrap.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No table yet. Generate one — steer it, or let Claude pick the comparison.</div>
    </div>`;
    return;
  }
  const head = a.columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
  const body = a.rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  wrap.innerHTML = `
    <div class="table-result-head">
      ${a.title ? `<h2 class="table-title">${escapeHtml(a.title)}</h2>` : '<span></span>'}
      <button class="btn btn-outline btn-sm" onclick="onDownloadTable()">↓ CSV</button>
    </div>
    <div class="table-scroll">
      <table class="cmp-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    </div>`;
}

/* Download the saved table as a CSV file — same Blob + <a download> pattern
   as the backup export. The UTF-8 BOM (backslash-uFEFF) makes Excel read UTF-8 accents right. */
function onDownloadTable() {
  const deck = getDeck(currentDeckId);
  const a = deck ? deck.artifacts.table : '';
  if (!a || a.type !== 'table') { toast('No table to download'); return; }

  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob(['\uFEFF' + tableToCsv(a)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-table-${slug}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Table downloaded');
}

async function onGenerateTable() {
  if (tableBusy) return;
  if (!getApiKey()) { openKeyModal(); setTableStatus('Add your API key first, then generate.'); return; }
  const deck = getDeck(currentDeckId);
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { setTableStatus('Add cards or material first.', 'error'); return; }

  const steering = document.getElementById('table-steering').value;
  tableBusy = true;
  document.getElementById('table-gen-btn').disabled = true;
  setTableStatus('Asking Claude to build the table…', 'busy');

  try {
    const r = await callClaudeTable(ctx.text, steering);
    if (!r.ok) {
      // Honest refusal reads as a quiet note; a broken response reads as an error.
      // Either way the saved table is untouched.
      if (r.reason === 'not_comparable') setArtRefusal('table-status', 'table', r.error);
      else setTableStatus(r.error, 'error', onGenerateTable);  // malformed = worth retrying
      return;
    }
    updateDeckArtifact(currentDeckId, 'table', {
      type: 'table', ...r.table, steering: steering.trim(), createdAt: Date.now()
    });
    setTableStatus('');
    renderTable();
    renderArtifactTabDots();
  } catch (err) {
    setTableStatus(err.message || 'Something went wrong.', 'error',
                  err.retryable ? onGenerateTable : null);
  } finally {
    tableBusy = false;
    document.getElementById('table-gen-btn').disabled = false;
  }
}

/* ----------------------------------------------------------------
   9D. VISUAL SUMMARY SHEET (Claude API, structured output)
   ----------------------------------------------------------------
   Context building is NOT duplicated here: the screen logic calls
   buildTableContext (9C) at runtime — same rule, already tested twice. */

/* ── 9D-pure. Sliced by "04 System/(C) test-sheet.mjs" — must stay
   contiguous and self-contained. ── */

const SHEET_TERMS_MAX = 10;  // a cheat sheet, not a glossary
const SHEET_POINTS_MAX = 8;  // one glance's worth of ideas
const SHEET_NUMBERS_MAX = 8; // only numbers the material actually contains

/* One user turn, no steering — a sheet digests the whole material. */
function buildSheetMessages(contextText) {
  return [{ role: 'user', content: `Build the pre-exam summary sheet from the material below, following all the rules.\n\nMaterial:\n${contextText}` }];
}

/* Claude's parsed JSON → a clean sheet or an honest failure. Blank-half
   entries are dropped; a sheet with nothing left in ANY section is refused
   rather than rendered blank. */
function parseSheetResponse(parsed) {
  const malformed = { ok: false, reason: 'malformed', error: 'Claude returned an unusable sheet. Try again.' };
  if (!parsed || typeof parsed !== 'object') return malformed;
  const str = v => typeof v === 'string' ? v.trim() : '';

  const keyTerms = (Array.isArray(parsed.keyTerms) ? parsed.keyTerms : [])
    .map(t => (t && typeof t === 'object') ? { term: str(t.term), definition: str(t.definition) } : null)
    .filter(t => t && t.term && t.definition)
    .slice(0, SHEET_TERMS_MAX);
  const mainPoints = (Array.isArray(parsed.mainPoints) ? parsed.mainPoints : [])
    .map(str).filter(Boolean).slice(0, SHEET_POINTS_MAX);
  const numbers = (Array.isArray(parsed.numbers) ? parsed.numbers : [])
    .map(n => (n && typeof n === 'object') ? { label: str(n.label), value: str(n.value) } : null)
    .filter(n => n && n.label && n.value)
    .slice(0, SHEET_NUMBERS_MAX);

  if (keyTerms.length === 0 && mainPoints.length === 0 && numbers.length === 0) return malformed;
  return { ok: true, sheet: { title: str(parsed.title), keyTerms, mainPoints, numbers } };
}

/* A saved sheet → a Markdown note (drops straight into an Obsidian vault).
   Empty sections are skipped. Garbage in → '' out, never throws. */
function sheetToMarkdown(sheet) {
  if (!sheet || !Array.isArray(sheet.keyTerms) || !Array.isArray(sheet.mainPoints) || !Array.isArray(sheet.numbers)) return '';
  const parts = [];
  if (typeof sheet.title === 'string' && sheet.title.trim()) parts.push(`# ${sheet.title.trim()}`);
  if (sheet.keyTerms.length) parts.push('## Key terms\n\n' + sheet.keyTerms.map(t => `**${t.term}** — ${t.definition}`).join('\n'));
  if (sheet.mainPoints.length) parts.push('## Main points\n\n' + sheet.mainPoints.map(p => `- ${p}`).join('\n'));
  if (sheet.numbers.length) parts.push('## Key numbers\n\n' + sheet.numbers.map(n => `- ${n.label}: ${n.value}`).join('\n'));
  return parts.join('\n\n');
}

/* A saved sheet → a self-contained HTML page (double-click → browser,
   print-ready). Inline styles, zero external requests. Same garbage rules
   as sheetToMarkdown. Own esc helper: the sliced block can't lean on
   escapeHtml (section 2). */
function sheetToHtml(sheet) {
  if (!sheet || !Array.isArray(sheet.keyTerms) || !Array.isArray(sheet.mainPoints) || !Array.isArray(sheet.numbers)) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = typeof sheet.title === 'string' ? sheet.title.trim() : '';
  if (!title && !sheet.keyTerms.length && !sheet.mainPoints.length && !sheet.numbers.length) return '';

  const terms = sheet.keyTerms.length ? `<h2>Key terms</h2>
<dl>${sheet.keyTerms.map(t => `<dt>${esc(t.term)}</dt><dd>${esc(t.definition)}</dd>`).join('')}</dl>` : '';
  const points = sheet.mainPoints.length ? `<h2>Main points</h2>
<ul>${sheet.mainPoints.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
  const numbers = sheet.numbers.length ? `<h2>Key numbers</h2>
${sheet.numbers.map(n => `<div class="num"><span>${esc(n.label)}</span><strong>${esc(n.value)}</strong></div>`).join('\n')}` : '';

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title || 'Summary sheet')}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #fff; color: #111; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.55; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #666; border-bottom: 1px solid #e2e2e2; padding-bottom: 6px; margin: 28px 0 12px; }
  dl { margin: 0; } dt { font-weight: 600; margin-top: 10px; } dd { margin: 2px 0 0; color: #333; }
  ul { margin: 0; padding-left: 20px; } li { margin: 6px 0; }
  .num { display: flex; justify-content: space-between; gap: 16px; padding: 7px 0; border-bottom: 1px dashed #e2e2e2; }
  .num span { color: #444; } .num strong { text-align: right; }
  @media print { body { margin: 0 auto; } }
</style>
<body>
${title ? `<h1>${esc(title)}</h1>` : ''}
${terms}
${points}
${numbers}
</body>
</html>`;
}

/* ── 9D-impure. The live call ── */

const SHEET_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    keyTerms: {
      type: 'array',
      items: { type: 'object', properties: { term: { type: 'string' }, definition: { type: 'string' } }, required: ['term', 'definition'], additionalProperties: false }
    },
    mainPoints: { type: 'array', items: { type: 'string' } },
    numbers: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } }, required: ['label', 'value'], additionalProperties: false }
    }
  },
  required: ['title', 'keyTerms', 'mainPoints', 'numbers'],
  additionalProperties: false
};

/* One click → one API call. Sonnet, 4096 tokens (sheets run longer than
   tables). Structured output — same schema trick as generation/table. */
async function callClaudeSheet(contextText) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You build one-page pre-exam summary sheets from a student's own study material. ` +
    `STRICT RULES:\n` +
    `1. Use ONLY the material — no outside knowledge, even if you know more.\n` +
    `2. Write in the SAME language as the material.\n` +
    `3. PLAIN TEXT everywhere — no markdown symbols.\n` +
    `4. "keyTerms": the most testable terms, definitions of at most 2 sentences. "mainPoints": one sentence each. ` +
    `"numbers": dates, percentages, quantities or formulas ONLY if they literally appear in the material — leave the array empty rather than invent.\n` +
    `5. Thin material → fewer items. Never pad, never repeat an idea across sections.\n` +
    `6. The material may be raw source text, or a summary plus flashcards — treat whichever you get as the full extent of what you know.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: SHEET_SCHEMA } },
        system: systemPrompt,
        messages: buildSheetMessages(contextText)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to build a sheet from this material.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }
  return parseSheetResponse(parsed);
}

/* ── 9D-screen. The sheet screen ── */

let sheetBusy = false;

function prepSheetTab() {
  sheetBusy = false;
  setSheetStatus('');
  renderSheet();
}

function setSheetStatus(msg, kind, retry) { setArtStatus('sheet-status', msg, kind, retry); }

function renderSheet() {
  const deck = getDeck(currentDeckId);
  const wrap = document.getElementById('sheet-result');
  const s = deck ? deck.artifacts.sheet : '';
  if (!s || s.type !== 'sheet') {
    wrap.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No sheet yet. One click — Claude reads the material and writes the cheat sheet.</div>
    </div>`;
    return;
  }
  const terms = s.keyTerms.length ? `
    <h3 class="sheet-h">Key terms</h3>
    <dl class="sheet-terms">${s.keyTerms.map(t => `<dt>${escapeHtml(t.term)}</dt><dd>${escapeHtml(t.definition)}</dd>`).join('')}</dl>` : '';
  const points = s.mainPoints.length ? `
    <h3 class="sheet-h">Main points</h3>
    <ul class="sheet-points">${s.mainPoints.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>` : '';
  const numbers = s.numbers.length ? `
    <h3 class="sheet-h">Key numbers</h3>
    <div class="sheet-numbers">${s.numbers.map(n => `<div class="sheet-num"><span>${escapeHtml(n.label)}</span><strong>${escapeHtml(n.value)}</strong></div>`).join('')}</div>` : '';
  wrap.innerHTML = `
    <div class="table-result-head">
      ${s.title ? `<h2 class="table-title">${escapeHtml(s.title)}</h2>` : '<span></span>'}
      <div class="dl-btns">
        <button class="btn btn-outline btn-sm" onclick="onDownloadSheet()">↓ MD</button>
        <button class="btn btn-outline btn-sm" onclick="onDownloadSheetHtml()">↓ HTML</button>
      </div>
    </div>
    ${terms}${points}${numbers}`;
}

/* Download the saved sheet as a Markdown file — same Blob + <a download>
   pattern as the backup and the table's CSV. */
function onDownloadSheet() {
  const deck = getDeck(currentDeckId);
  const s = deck ? deck.artifacts.sheet : '';
  if (!s || s.type !== 'sheet') { toast('No sheet to download'); return; }

  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob([sheetToMarkdown(s)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-sheet-${slug}.md`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Sheet downloaded');
}

/* Same download pattern, HTML flavor — a file that double-click opens in
   the browser already rendered (and prints cleanly). */
function onDownloadSheetHtml() {
  const deck = getDeck(currentDeckId);
  const s = deck ? deck.artifacts.sheet : '';
  if (!s || s.type !== 'sheet') { toast('No sheet to download'); return; }

  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob([sheetToHtml(s)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-sheet-${slug}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Sheet downloaded');
}

async function onGenerateSheet() {
  if (sheetBusy) return;
  if (!getApiKey()) { openKeyModal(); setSheetStatus('Add your API key first, then generate.'); return; }
  const deck = getDeck(currentDeckId);
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { setSheetStatus('Add cards or material first.', 'error'); return; }

  sheetBusy = true;
  document.getElementById('sheet-gen-btn').disabled = true;
  setSheetStatus('Asking Claude to write the sheet…', 'busy');

  try {
    const r = await callClaudeSheet(ctx.text);
    // The message ends "Try again." — so it must come WITH a way to. saved sheet untouched
    if (!r.ok) { setSheetStatus(r.error, 'error', onGenerateSheet); return; }
    updateDeckArtifact(currentDeckId, 'sheet', { type: 'sheet', ...r.sheet, createdAt: Date.now() });
    setSheetStatus('');
    renderSheet();
    renderArtifactTabDots();
  } catch (err) {
    setSheetStatus(err.message || 'Something went wrong.', 'error',
                  err.retryable ? onGenerateSheet : null);
  } finally {
    sheetBusy = false;
    document.getElementById('sheet-gen-btn').disabled = false;
  }
}

/* ----------------------------------------------------------------
   9E. CONCEPT MAP (Claude API, structured output, hand-rolled SVG)
   ----------------------------------------------------------------
   Context building is NOT duplicated here: the screen logic calls
   buildTableContext (9C) at runtime — same rule as chat/table/sheet.
   No render library: a ≤12-node map only needs a radial layout, and
   pure geometry is unit-testable where a library call never is. */

/* ── 9E-pure. Sliced by "04 System/(C) test-map.mjs" — must stay
   contiguous and self-contained. ── */

const MAP_NODES_MAX = 12;      // a study map, not a knowledge graph
const MAP_EDGES_MAX = 18;      // fewer, truer relations
const MAP_LABEL_MAX = 32;      // total chars across a pill's two lines
const MAP_LINE_MAX = 16;       // chars per pill line before wrapping
const MAP_EDGE_LABEL_MAX = 18; // chars per edge-label line before it wraps
const MAP_EDGE_LINES = 2;      // a phrase wraps onto ≤2 lines, then … as a last resort
const MAP_ROW_H = 60;          // vertical rhythm — one leaf per row
const MAP_H_GAP = 96;          // horizontal room per connector + its phrase
const MAP_MARGIN = 36;         // canvas padding around the outermost pills

/* One user turn, no steering — a map digests the whole material. */
function buildMapMessages(contextText) {
  return [{ role: 'user', content: `Build the concept map from the material below, following all the rules.\n\nMaterial:\n${contextText}` }];
}

/* Claude's parsed JSON → a clean map or an honest failure. Blank/duplicate
   nodes and dangling/self-loop/duplicate edges are dropped; a map with
   fewer than 3 concepts or no relations left is refused, never rendered. */
function parseMapResponse(parsed) {
  const malformed = { ok: false, reason: 'malformed', error: 'Claude returned an unusable map. Try again.' };
  if (!parsed || typeof parsed !== 'object') return malformed;
  const str = v => typeof v === 'string' ? v.trim() : '';

  const seenIds = new Set();
  const nodes = [];
  for (const n of (Array.isArray(parsed.nodes) ? parsed.nodes : [])) {
    if (!n || typeof n !== 'object') continue;
    const id = str(n.id), label = str(n.label);
    if (!id || !label || seenIds.has(id)) continue;
    seenIds.add(id);
    nodes.push({ id, label });
    if (nodes.length === MAP_NODES_MAX) break;
  }

  const seenPairs = new Set();
  const edges = [];
  for (const e of (Array.isArray(parsed.edges) ? parsed.edges : [])) {
    if (!e || typeof e !== 'object') continue;
    const from = str(e.from), to = str(e.to);
    if (!from || !to || from === to || !seenIds.has(from) || !seenIds.has(to)) continue;
    const pair = from + '→' + to;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    edges.push({ from, to, label: str(e.label) });
    if (edges.length === MAP_EDGES_MAX) break;
  }

  if (nodes.length < 3 || edges.length === 0) return malformed;

  let centralId = str(parsed.centralId);
  if (!seenIds.has(centralId)) {
    const degree = {};
    for (const e of edges) { degree[e.from] = (degree[e.from] || 0) + 1; degree[e.to] = (degree[e.to] || 0) + 1; }
    centralId = nodes.reduce((best, n) => (degree[n.id] || 0) > (degree[best.id] || 0) ? n : best, nodes[0]).id;
  }

  return { ok: true, map: { title: str(parsed.title), centralId, nodes, edges } };
}

/* Greedy word-wrap onto at most two pill lines; overflow ends in an
   ellipsis, single words longer than a line are hard-cut, never lost. */
function wrapMapLabel(label) {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let overflow = false;
  for (const word of words) {
    let w = word;
    while (!overflow) {
      const cand = cur ? cur + ' ' + w : w;
      if (cand.length <= MAP_LINE_MAX) { cur = cand; break; }
      if (!cur && w.length > MAP_LINE_MAX) { // a single word wider than a line
        lines.push(w.slice(0, MAP_LINE_MAX));
        w = w.slice(MAP_LINE_MAX);
        if (lines.length === 2) overflow = true;
        continue;
      }
      lines.push(cur);
      cur = '';
      if (lines.length === 2) overflow = true;
    }
    if (overflow) break;
  }
  if (!overflow && cur) lines.push(cur);
  if (overflow) lines[1] = lines[1].slice(0, MAP_LINE_MAX - 1) + '…';
  return lines.length ? lines : [''];
}

/* Word-wrap a relation phrase onto ≤ MAP_EDGE_LINES lines so a long label
   flows under the connector instead of being chopped with an ellipsis. Only
   when even the last allowed line overflows do we fall back to a trailing … */
function wrapEdgeLabel(label) {
  const words = String(label).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [''];
  for (const w of words) {
    const i = lines.length - 1;
    const cand = lines[i] ? lines[i] + ' ' + w : w;
    if (cand.length <= MAP_EDGE_LABEL_MAX || !lines[i]) lines[i] = cand;
    else if (lines.length < MAP_EDGE_LINES) lines.push(w);
    else lines[i] = cand; // out of lines — let it overflow, then ellipsise below
  }
  const last = lines.length - 1;
  if (lines[last].length > MAP_EDGE_LABEL_MAX) lines[last] = lines[last].slice(0, MAP_EDGE_LABEL_MAX - 1) + '…';
  return lines;
}

/* BFS spanning tree from the central concept (edges walked undirected so a
   backwards relation can't strand a node). Tree links carry the relation
   phrase (`via`); leftover edges are cross-links; unreachable nodes hang
   off the root so nothing is silently lost. */
function buildMapTree(map) {
  const byId = new Map(map.nodes.map(n => [n.id, n]));
  const adj = new Map(map.nodes.map(n => [n.id, []]));
  for (const e of map.edges) {
    adj.get(e.from).push({ other: e.to, edge: e });
    adj.get(e.to).push({ other: e.from, edge: e });
  }
  const mk = id => ({ id, label: byId.get(id).label, via: '', children: [] });
  const root = mk(map.centralId);
  const visited = new Set([root.id]);
  const usedEdges = new Set();
  // Level-synchronous BFS: within each level, edges pointing OUT of a node
  // (from → to) claim children before backwards ones — the AI writes
  // relations parent-first, so the tree should follow the arrows.
  let frontier = [root];
  while (frontier.length) {
    const next = [];
    for (const directedOnly of [true, false]) {
      for (const cur of frontier) {
        for (const { other, edge } of adj.get(cur.id)) {
          if (visited.has(other)) continue;
          if (directedOnly && edge.from !== cur.id) continue;
          visited.add(other);
          usedEdges.add(edge);
          const child = mk(other);
          child.via = edge.label;
          cur.children.push(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  for (const n of map.nodes) {
    if (!visited.has(n.id)) { visited.add(n.id); root.children.push(mk(n.id)); }
  }
  return { root, crossEdges: map.edges.filter(e => !usedEdges.has(e)) };
}

/* Pure geometry, mind-map style: central pill in the middle, first-level
   branches split left/right (greedily balanced by leaf count), children
   stacked in per-depth columns, a parent at the vertical midpoint of its
   children. Deterministic — same map, same picture. */
function layoutMap(map) {
  const dims = new Map(map.nodes.map(n => {
    const lines = wrapMapLabel(n.label);
    const maxLen = Math.max(...lines.map(l => l.length));
    // The central anchor carries larger display type, so it needs more box.
    const central = n.id === map.centralId;
    const w = central ? maxLen * 10 + 44 : maxLen * 7.5 + 26;
    const h = central ? (lines.length > 1 ? 60 : 44) : (lines.length > 1 ? 46 : 30);
    return [n.id, { lines, w, h }];
  }));
  const { root, crossEdges } = buildMapTree(map);
  const rootDim = dims.get(root.id);

  const leafCount = t => t.children.length ? t.children.reduce((s, c) => s + leafCount(c), 0) : 1;

  const left = [], right = [];
  let leftLeaves = 0, rightLeaves = 0;
  for (const branch of root.children) {
    const n = leafCount(branch);
    if (rightLeaves <= leftLeaves) { right.push(branch); rightLeaves += n; }
    else { left.push(branch); leftLeaves += n; }
  }

  const placed = [];
  const links = [];
  // Places one side; returns its row count. xOff is measured from the
  // central pill's center, sign −1 for the left side.
  const placeSide = (branches, sign) => {
    const colW = [];
    const measure = (t, d) => { colW[d] = Math.max(colW[d] || 0, dims.get(t.id).w); t.children.forEach(c => measure(c, d + 1)); };
    branches.forEach(b => measure(b, 0));
    const colX = [];
    let acc = rootDim.w / 2 + MAP_H_GAP;
    for (let d = 0; d < colW.length; d++) { colX[d] = acc + colW[d] / 2; acc += colW[d] + MAP_H_GAP; }

    let cursor = 0;
    const walk = (t, d, parentId) => {
      const node = { id: t.id, label: t.label, via: t.via, ...dims.get(t.id), xOff: colX[d] * sign, sign };
      links.push({ from: parentId, to: t.id, label: t.via, kind: 'tree' });
      if (!t.children.length) { node.row = cursor; cursor += 1; }
      else {
        const rows = t.children.map(c => walk(c, d + 1, t.id));
        node.row = (Math.min(...rows) + Math.max(...rows)) / 2;
      }
      placed.push(node);
      return node.row;
    };
    branches.forEach(b => walk(b, 0, root.id));
    return cursor;
  };

  const leftRows = placeSide(left, -1);
  const rightRows = placeSide(right, 1);
  const maxRows = Math.max(leftRows, rightRows, 1);

  // Center each side vertically; central pill sits mid-canvas.
  const rowY = (row, sideRows) => MAP_MARGIN + ((maxRows - sideRows) / 2 + row + 0.5) * MAP_ROW_H;
  const midY = MAP_MARGIN + (maxRows * MAP_ROW_H) / 2;
  const withY = placed.map(n => ({ ...n, y: rowY(n.row, n.sign < 0 ? leftRows : rightRows) }));

  const leftMost = Math.min(-rootDim.w / 2, ...withY.map(n => n.xOff - n.w / 2));
  const rightMost = Math.max(rootDim.w / 2, ...withY.map(n => n.xOff + n.w / 2));
  const centralX = MAP_MARGIN - leftMost;

  const nodes = [
    { id: root.id, label: root.label, via: '', ...rootDim, x: centralX, y: midY },
    ...withY.map(n => ({ id: n.id, label: n.label, via: n.via, lines: n.lines, w: n.w, h: n.h, x: centralX + n.xOff, y: n.y }))
  ];
  return {
    nodes,
    links: [...links, ...crossEdges.map(e => ({ from: e.from, to: e.to, label: e.label, kind: 'cross' }))],
    width: Math.round(rightMost - leftMost + 2 * MAP_MARGIN),
    height: Math.round(maxRows * MAP_ROW_H + 2 * MAP_MARGIN)
  };
}

/* A parsed map → one standalone monochrome SVG string. Doubles as the
   future ↓ SVG exporter. Garbage in → '' out, never throws. Own esc
   helper: the sliced block can't lean on escapeHtml (section 2). */
/* Deterministic short id from content. These blocks are sliced standalone by
   the test suites, so they cannot reach newId() — and a random id would make a
   pure function non-deterministic for no reason. Output is [0-9a-z] only, so it
   is safe in an id attribute unescaped. (a11y audit, 2026-07-27) */
function svgUid(seed) {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function mapToSvg(map) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges) || map.nodes.length === 0) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const l = layoutMap(map);
  const pos = {};
  for (const n of l.nodes) pos[n.id] = n;

  // Tree links: horizontal béziers from the parent's edge to the child's,
  // the relation phrase in small grey at the child end (each child has one
  // incoming link, so phrases get their own row and can't pile up).
  // Cross-links (relations the hierarchy can't hold) render dashed.
  const EDGE_LH = 11;
  const EDGE_CHAR_W = 5.1;        // ≈ Inter at 9.5px — same estimation style as the node dims
  const EDGE_STEP = EDGE_LH + 3;
  const EDGE_MAX_STEPS = 6;

  // Pass 1 — geometry for every connector and the box its label will occupy.
  const drawn = l.links.map(link => {
    const a = pos[link.from], b = pos[link.to];
    if (!a || !b) return null;
    const sign = b.x >= a.x ? 1 : -1;
    const sx = a.x + (a.w / 2) * sign, ex = b.x - (b.w / 2) * sign;
    // Symmetric horizontal cubic: both control points sit at the horizontal
    // midpoint, giving an even S that reads as intentional, not spaghetti.
    const mx = (sx + ex) / 2;
    const lines = link.label ? wrapEdgeLabel(link.label) : [];
    return {
      link, a, b, sx, ex, mx, lines,
      cy: (a.y + b.y) / 2,
      w: lines.length ? Math.max(...lines.map(s => s.length)) * EDGE_CHAR_W : 0,
      h: lines.length * EDGE_LH
    };
  }).filter(Boolean);

  // Pass 2 — resolve label collisions. A TREE label owns its connector's
  // midpoint: each child has exactly one incoming link and its own row, so
  // siblings cannot pile up. A CROSS label has no such guarantee — two nodes on
  // the SAME ROW put its midpoint straight on top of a tree label. (Found on
  // screen 2026-07-28: "começa com" at x=435 and "assinado por" at x=423.5,
  // both at y=69.) So cross labels yield: they step off the shared baseline
  // until they clear. Tree labels never move.
  const boxes = [];
  const hits = (x, y, w, h) => boxes.some(o =>
    Math.abs(x - o.x) < (w + o.w) / 2 + 2 && Math.abs(y - o.y) < (h + o.h) / 2 + 2);

  for (const d of drawn) {
    if (!d.lines.length || d.link.kind === 'cross') continue;
    d.ly = d.cy;
    boxes.push({ x: d.mx, y: d.cy, w: d.w, h: d.h });
  }
  for (const d of drawn) {
    if (!d.lines.length || d.link.kind !== 'cross') continue;
    let y = d.cy;
    // Step down, or up when down would leave the canvas. Bounded, and a pure
    // function of the layout — the same map always draws the same way.
    for (let s = 1; s <= EDGE_MAX_STEPS && hits(d.mx, y, d.w, d.h); s++) {
      const down = d.cy + s * EDGE_STEP;
      y = (down + d.h / 2 + 4 <= l.height) ? down : d.cy - s * EDGE_STEP;
    }
    d.ly = y;
    boxes.push({ x: d.mx, y, w: d.w, h: d.h });
  }

  // Pass 3 — draw. Relation phrase: small, discreet, centred on the connector so
  // it reads as belonging to that line; long phrases wrap under it, halo punched
  // out in the canvas tone so the stroke stays legible over the line.
  const connectors = drawn.map(d => {
    const dash = d.link.kind === 'cross' ? ' stroke-dasharray="4 4" opacity="0.5"' : '';
    const path = `<path d="M ${d.sx} ${d.a.y} C ${d.mx} ${d.a.y}, ${d.mx} ${d.b.y}, ${d.ex} ${d.b.y}" fill="none" stroke="#C4C4BF" stroke-width="1.25" stroke-linecap="round"${dash}/>`;
    if (!d.lines.length) return path;
    const y0 = d.ly - ((d.lines.length - 1) * EDGE_LH) / 2 + 3;
    const tspans = d.lines.map((ln, i) => `<tspan x="${d.mx}" dy="${i === 0 ? 0 : EDGE_LH}">${esc(ln)}</tspan>`).join('');
    return path + `<text x="${d.mx}" y="${y0}" text-anchor="middle" fill="#666666" font-size="9.5" stroke="#F0F0EE" stroke-width="3.5" paint-order="stroke">${tspans}</text>`;
  }).join('\n');

  const nodePills = l.nodes.map(n => {
    const isCentral = n.id === map.centralId;
    // Central: heavy dark anchor, thin/large display title, pill radius.
    // Children: quiet --surface-1 cards, standard 4px radius.
    const rx = isCentral ? n.h / 2 : 4;
    const fill = isCentral ? '#0A0A0A' : '#E8E8E6';
    const stroke = isCentral ? '#0A0A0A' : '#DDDDD8';
    const textFill = isCentral ? '#F0F0EE' : '#0A0A0A';
    const lineH = isCentral ? 20 : 15;
    const single = isCentral ? 6 : 4.5;
    const firstDy = n.lines.length > 1 ? (isCentral ? -6 : -3) : single;
    const tspans = n.lines.map((line, li) => `<tspan x="${n.x}" dy="${li === 0 ? firstDy : lineH}">${esc(line)}</tspan>`).join('');
    const textAttrs = isCentral
      ? ` font-family="'DM Sans', -apple-system, 'Segoe UI', sans-serif" font-size="18" font-weight="200" letter-spacing="-0.02em"`
      : ` font-size="12.5"`;
    return `<g><rect x="${n.x - n.w / 2}" y="${n.y - n.h / 2}" width="${n.w}" height="${n.h}" rx="${rx}" fill="${fill}" stroke="${stroke}"/>` +
      `<text x="${n.x}" y="${n.y}" text-anchor="middle" fill="${textFill}"${textAttrs}>${tspans}</text></g>`;
  }).join('\n');

  // Accessibility: the whole drawing is one image with a name and a short
  // orienting description. The relations themselves live in mapToList() — a
  // 12-node graph read out as prose is worse than useless; a nested list mirrors
  // what a sighted eye does, starting at the centre and following a branch.
  const centralNode = map.nodes.find(n => n.id === map.centralId) || map.nodes[0];
  const centralLabel = centralNode ? centralNode.label : '';
  const mapTitleText = (typeof map.title === 'string' && map.title.trim()) ? map.title.trim() : centralLabel;
  const svgTitle = `Concept map: ${mapTitleText}`;
  const svgDesc = `Concept map centred on "${centralLabel}", with ${map.nodes.length} concepts and ${map.edges.length} relations.`;
  const uid = svgUid(`map|${map.centralId}|${map.title}|${map.nodes.length}|${map.edges.length}`);
  const titleId = `map-title-${uid}`, descId = `map-desc-${uid}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${l.width}" height="${l.height}" viewBox="0 0 ${l.width} ${l.height}" font-family="'Inter', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" role="img" focusable="false" aria-labelledby="${titleId} ${descId}" aria-describedby="${descId}">
<title id="${titleId}">${esc(svgTitle)}</title>
<desc id="${descId}">${esc(svgDesc)}</desc>
<g aria-hidden="true">
<rect width="${l.width}" height="${l.height}" fill="#F0F0EE"/>
${connectors}
${nodePills}
</g>
</svg>`;
}

/* The map as a nested list — the thing a non-sighted student actually studies
   from. Walks the SAME tree layoutMap draws, so the two cannot drift apart.
   Cross-links (the dashed ones a tree cannot hold) get their own flat list,
   the same distinction sighted readers get from the dashed stroke. */
function mapToList(map) {
  if (!map || !Array.isArray(map.nodes) || !Array.isArray(map.edges) || map.nodes.length === 0) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const { root, crossEdges } = buildMapTree(map);

  const childList = kids => kids && kids.length
    ? `<ul>${kids.map(k =>
        `<li>${k.via ? `<span class="map-rel">${esc(k.via)}:</span> ` : ''}${esc(k.label)}${childList(k.children)}</li>`
      ).join('')}</ul>`
    : '';

  const cross = crossEdges.length
    ? `<h3 class="map-list-h">Other relations</h3><ul class="map-cross">${crossEdges.map(e => {
        const from = map.nodes.find(n => n.id === e.from), to = map.nodes.find(n => n.id === e.to);
        return `<li>${esc(from ? from.label : e.from)} <span class="map-rel">${esc(e.label || 'relates to')}</span> ${esc(to ? to.label : e.to)}</li>`;
      }).join('')}</ul>`
    : '';

  return `<div class="map-list"><h3 class="map-list-h">Concepts and relations</h3>` +
         `<ul><li><strong>${esc(root.label)}</strong>${childList(root.children)}</li></ul></div>${cross}`;
}

/* A saved map → a self-contained HTML page (double-click → browser,
   print-ready): the natural-size SVG wrapped in a forced-light document.
   Same garbage rules as the other exporters — '' out, never throws. */
function mapToHtml(map, lang) {
  const svg = mapToSvg(map);
  if (!svg) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = (map && typeof map.title === 'string' && map.title.trim()) ? map.title.trim() : 'Concept map';
  // The material may be Portuguese; a hardcoded lang="en" makes a screen reader
  // pronounce it with English phonetics. The deck already knows its language.
  const htmlLang = (typeof lang === 'string' && lang.trim()) ? lang.trim() : 'en';
  return `<!doctype html>
<html lang="${esc(htmlLang)}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #fff; color: #111; margin: 32px; }
  h1 { font-size: 22px; margin: 0 0 18px; }
  .wrap { overflow-x: auto; }
  .map-list ul, .map-cross { margin: 4px 0; padding-left: 22px; }
  .map-list-h { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: #666; margin: 22px 0 6px; }
  .map-rel { color: #666; font-weight: 400; }
  @media print { body { margin: 0; } }
</style>
<body>
<h1>${esc(title)}</h1>
<div class="wrap">
${svg}
</div>
${mapToList(map)}
</body>
</html>`;
}

/* ── 9E-impure. The live call ── */

const MAP_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    centralId: { type: 'string' },
    nodes: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false }
    },
    edges: {
      type: 'array',
      items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, label: { type: 'string' } }, required: ['from', 'to', 'label'], additionalProperties: false }
    }
  },
  required: ['title', 'centralId', 'nodes', 'edges'],
  additionalProperties: false
};

/* One click → one API call. Sonnet, structured output — same schema trick,
   fifth time. */
async function callClaudeMap(contextText) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You build concept maps from a student's own study material: the key concepts and how they relate. ` +
    `STRICT RULES:\n` +
    `1. Use ONLY the material — no outside knowledge, even if you know more.\n` +
    `2. Write in the SAME language as the material.\n` +
    `3. PLAIN TEXT everywhere — no markdown symbols.\n` +
    `4. "nodes": 4-12 concepts, short noun-phrase labels. "centralId": the node the material is actually about. ` +
    `"edges": each has a short connecting phrase as its label, readable as "A —label→ B" (e.g. "causes", "é parte de"); ` +
    `only relations the material really states — prefer fewer, truer relations over a dense web.\n` +
    `5. Thin material → smaller map. Never pad, never invent a relation.\n` +
    `6. The material may be raw source text, or a summary plus flashcards — treat whichever you get as the full extent of what you know.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: MAP_SCHEMA } },
        system: systemPrompt,
        messages: buildMapMessages(contextText)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to build a map from this material.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }
  return parseMapResponse(parsed);
}

/* ── 9E-screen. The Map tab of the artifacts screen ── */

let mapBusy = false;

function prepMapTab() {
  mapBusy = false;
  setMapStatus('');
  renderMap();
}

function setMapStatus(msg, kind, retry) { setArtStatus('map-status', msg, kind, retry); }

function renderMap() {
  const deck = getDeck(currentDeckId);
  const wrap = document.getElementById('map-result');
  const m = deck ? deck.artifacts.map : '';
  if (!m || m.type !== 'map') {
    wrap.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No map yet. One click — Claude finds the concepts and draws how they connect.</div>
    </div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-result-head">
      ${m.title ? `<h2 class="table-title">${escapeHtml(m.title)}</h2>` : '<span></span>'}
      <div class="dl-btns">
        <button class="btn btn-outline btn-sm" onclick="onDownloadMapHtml()">↓ HTML</button>
      </div>
    </div>
    <div class="map-svg">${mapToSvg(m)}</div>
    <details class="alt-view">
      <summary>Read as a list</summary>
      ${mapToList(m)}
    </details>`;
}

/* Same download pattern as the sheet's ↓ HTML — a file that double-click
   opens in the browser already drawn. */
function onDownloadMapHtml() {
  const deck = getDeck(currentDeckId);
  const m = deck ? deck.artifacts.map : '';
  if (!m || m.type !== 'map') { toast('No map to download'); return; }

  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob([mapToHtml(m, deckLang(currentDeckId))], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-map-${slug}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Map downloaded');
}

async function onGenerateMap() {
  if (mapBusy) return;
  if (!getApiKey()) { openKeyModal(); setMapStatus('Add your API key first, then generate.'); return; }
  const deck = getDeck(currentDeckId);
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { setMapStatus('Add cards or material first.', 'error'); return; }

  mapBusy = true;
  document.getElementById('map-gen-btn').disabled = true;
  setMapStatus('Asking Claude to draw the map…', 'busy');

  try {
    const r = await callClaudeMap(ctx.text);
    // The message ends "Try again." — so it must come WITH a way to. saved map untouched
    if (!r.ok) { setMapStatus(r.error, 'error', onGenerateMap); return; }
    updateDeckArtifact(currentDeckId, 'map', { type: 'map', ...r.map, createdAt: Date.now() });
    setMapStatus('');
    renderMap();
    renderArtifactTabDots();
  } catch (err) {
    setMapStatus(err.message || 'Something went wrong.', 'error',
                  err.retryable ? onGenerateMap : null);
  } finally {
    mapBusy = false;
    document.getElementById('map-gen-btn').disabled = false;
  }
}

/* ----------------------------------------------------------------
   9F. TIMELINE
   ----------------------------------------------------------------
   The 5th study artifact: the deck's material as an ordered sequence
   — dated events or undated steps. The pure block (constants → HTML
   string) is unit-tested by slicing; the live call + DOM screen follow. */

const TIMELINE_EVENTS_MAX = 15;  // a study timeline, not a chronicle
const TIMELINE_MIN_EVENTS = 2;   // one point isn't a sequence — below this we refuse

/* One user turn carrying the material — a timeline digests the whole thing. */
function buildTimelineMessages(contextText) {
  return [{ role: 'user', content: `Build the study timeline from the material below, following all the rules.\n\nMaterial:\n${contextText}` }];
}

/* Claude's parsed JSON → an ordered timeline or an honest failure. Events
   with no label are dropped; when/detail default to '' when absent; events
   stay in the order Claude returned them. A timeline with fewer than
   TIMELINE_MIN_EVENTS real events is refused rather than rendered as a
   lonely dot — the "material has no real sequence" path. */
function parseTimelineResponse(parsed) {
  const malformed = { ok: false, reason: 'malformed', error: 'Claude returned an unusable timeline. Try again.' };
  if (!parsed || typeof parsed !== 'object') return malformed;
  const str = v => typeof v === 'string' ? v.trim() : '';

  const events = (Array.isArray(parsed.events) ? parsed.events : [])
    .map(e => (e && typeof e === 'object') ? { when: str(e.when), label: str(e.label), detail: str(e.detail) } : null)
    .filter(e => e && e.label)
    .slice(0, TIMELINE_EVENTS_MAX);

  if (events.length < TIMELINE_MIN_EVENTS) return malformed;
  return { ok: true, timeline: { title: str(parsed.title), events } };
}

/* A timeline → the inner <ol class="tl">…</ol> markup. Pure and SHARED by
   both the in-app render and the ↓ HTML export, so the two can't drift.
   when/detail are omitted when empty. Own esc helper: the sliced block
   can't lean on escapeHtml (section 2). Garbage in → '', never throws. */
function timelineRowsHtml(tl) {
  if (!tl || !Array.isArray(tl.events) || tl.events.length === 0) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = tl.events.map(e => {
    const when = e.when ? `<span class="tl-when">${esc(e.when)}</span>` : '';
    const detail = e.detail ? `<p class="tl-detail">${esc(e.detail)}</p>` : '';
    return `<li class="tl-item"><span class="tl-node"></span><div class="tl-card">${when}<div class="tl-label">${esc(e.label)}</div>${detail}</div></li>`;
  }).join('\n');
  return `<ol class="tl">\n${items}\n</ol>`;
}

/* A saved timeline → a self-contained HTML page (double-click → browser,
   print-ready). Inline styles, forced light so dark-mode browsers can't
   black it out. Same garbage rules as the other exporters — '' out, never
   throws. Reuses timelineRowsHtml for the body; own esc for the title. */
function timelineToHtml(tl) {
  const rows = timelineRowsHtml(tl);
  if (!rows) return '';
  const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const title = (tl && typeof tl.title === 'string' && tl.title.trim()) ? tl.title.trim() : 'Timeline';
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; background: #fff; color: #111; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.55; }
  h1 { font-size: 26px; margin: 0 0 24px; }
  ol.tl { list-style: none; margin: 0; padding: 0 0 0 24px; border-left: 2px solid #e2e2e2; }
  li.tl-item { position: relative; padding: 0 0 24px 20px; }
  li.tl-item:last-child { padding-bottom: 0; }
  .tl-node { position: absolute; left: -33px; top: 3px; width: 10px; height: 10px; border-radius: 9999px; background: #111; border: 2px solid #fff; }
  .tl-when { display: inline-block; font-size: 12px; letter-spacing: .04em; color: #888; margin-bottom: 2px; }
  .tl-label { font-weight: 600; font-size: 16px; color: #111; }
  .tl-detail { margin: 4px 0 0; color: #444; }
  @media print { body { margin: 0 auto; } }
</style>
<body>
<h1>${esc(title)}</h1>
${rows}
</body>
</html>`;
}

/* ── 9F-impure. The live call ── */

const TIMELINE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: { when: { type: 'string' }, label: { type: 'string' }, detail: { type: 'string' } },
        required: ['when', 'label', 'detail'],
        additionalProperties: false
      }
    }
  },
  required: ['title', 'events'],
  additionalProperties: false
};

/* One click → one API call. Sonnet, 4096 tokens. Structured output — same
   schema trick as generation/table/sheet/map. */
async function callClaudeTimeline(contextText) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You build study timelines from a student's own study material: the material's events or steps in the order they happen. ` +
    `STRICT RULES:\n` +
    `1. Use ONLY the material — no outside knowledge, even if you know more.\n` +
    `2. Write in the SAME language as the material.\n` +
    `3. PLAIN TEXT everywhere — no markdown symbols.\n` +
    `4. "events": 2-15 entries IN ORDER (chronological, or the logical step order). Each has a short "label" — the event or step. ` +
    `"when" is a date, year, era or step marker ONLY if the material states one, otherwise "". ` +
    `"detail" is at most 1-2 sentences of context, or "" when the label already says it.\n` +
    `5. Only what the material really states — never invent an event, a date, or an order. Thin material → shorter timeline.\n` +
    `6. If the material has no real sequence to lay out, return fewer than 2 events rather than forcing one.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        output_config: { format: { type: 'json_schema', schema: TIMELINE_SCHEMA } },
        system: systemPrompt,
        messages: buildTimelineMessages(contextText)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to build a timeline from this material.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }
  return parseTimelineResponse(parsed);
}

/* ── 9F-screen. The Timeline tab of the artifacts screen ── */

let timelineBusy = false;

function prepTimelineTab() {
  timelineBusy = false;
  setTimelineStatus('');
  renderTimeline();
}

function setTimelineStatus(msg, kind, retry) { setArtStatus('timeline-status', msg, kind, retry); }

function renderTimeline() {
  const deck = getDeck(currentDeckId);
  const wrap = document.getElementById('timeline-result');
  const t = deck ? deck.artifacts.timeline : '';
  if (!t || t.type !== 'timeline') {
    wrap.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No timeline yet. One click — Claude lays out the material's events in order.</div>
    </div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-result-head">
      ${t.title ? `<h2 class="table-title">${escapeHtml(t.title)}</h2>` : '<span></span>'}
      <div class="dl-btns">
        <button class="btn btn-outline btn-sm" onclick="onDownloadTimelineHtml()">↓ HTML</button>
      </div>
    </div>
    <div class="timeline-wrap">${timelineRowsHtml(t)}</div>`;
}

/* Same download pattern as the map's ↓ HTML — a file that double-click
   opens in the browser already drawn. */
function onDownloadTimelineHtml() {
  const deck = getDeck(currentDeckId);
  const t = deck ? deck.artifacts.timeline : '';
  if (!t || t.type !== 'timeline') { toast('No timeline to download'); return; }

  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob([timelineToHtml(t)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-timeline-${slug}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Timeline downloaded');
}

async function onGenerateTimeline() {
  if (timelineBusy) return;
  if (!getApiKey()) { openKeyModal(); setTimelineStatus('Add your API key first, then generate.'); return; }
  const deck = getDeck(currentDeckId);
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { setTimelineStatus('Add cards or material first.', 'error'); return; }

  timelineBusy = true;
  document.getElementById('timeline-gen-btn').disabled = true;
  setTimelineStatus('Asking Claude to lay out the timeline…', 'busy');

  try {
    const r = await callClaudeTimeline(ctx.text);
    // The message ends "Try again." — so it must come WITH a way to. saved timeline untouched
    if (!r.ok) { setTimelineStatus(r.error, 'error', onGenerateTimeline); return; }
    updateDeckArtifact(currentDeckId, 'timeline', { type: 'timeline', ...r.timeline, createdAt: Date.now() });
    setTimelineStatus('');
    renderTimeline();
    renderArtifactTabDots();
  } catch (err) {
    setTimelineStatus(err.message || 'Something went wrong.', 'error',
                  err.retryable ? onGenerateTimeline : null);
  } finally {
    timelineBusy = false;
    document.getElementById('timeline-gen-btn').disabled = false;
  }
}

/* ----------------------------------------------------------------
   9G. CHARTS & GRAPHS (Claude API, structured output)
   ----------------------------------------------------------------
   The 6th study artifact, 5th Artifacts tab, and the LAST planned
   type. The narrowest one: it only fires when the material has real
   numbers — otherwise it refuses, honestly, like the table does.
   Context building is NOT duplicated: the screen calls buildTableContext
   (9C) at runtime — same rule, already tested. */

/* ── 9G-pure. Sliced by "04 System/(C) test-chart.mjs" — must stay
   contiguous and self-contained (its own esc, no DOM, no escapeHtml). ── */

const CHART_POINTS_MAX = 12;           // a study chart, not a spreadsheet
const CHART_POINTS_MIN = 2;            // one point isn't a chart — below this we refuse
const CHART_TYPES = ['bar', 'line', 'pie'];

/* One user turn: the request (steered or auto-pick) + the material. */
function buildChartMessages(contextText, steering) {
  const want = typeof steering === 'string' ? steering.trim() : '';
  const ask = want
    ? `Build a chart of: ${want}`
    : `Find the single most study-worthy quantitative relationship in the material and build the chart a student would want before a test.`;
  return [{ role: 'user', content: `${ask}\n\nMaterial:\n${contextText}` }];
}

/* Claude's parsed JSON → a clean chart or an honest refusal. Refusal shape is
   { chartable:false, reason } — surfaced by the same quiet-note path the table
   uses for "not comparable". Success is { chartable:true, chart:{…} }. Rows
   with no finite number are DROPPED (dropping ≠ inventing); if fewer than
   CHART_POINTS_MIN survive we refuse rather than draw a one-bar chart. */
function parseChartResponse(parsed) {
  // `malformed` separates "Claude sent back junk" from "your material has no
  // numbers". Both stop the chart, but they need OPPOSITE advice: press the
  // button again vs. import richer material. Without the flag the app blames
  // the student for a bad API response — and offers no way to retry.
  const refuse = (reason, malformed) => ({
    chartable: false,
    reason: reason || 'Couldn’t read a chart from this material. Try again.',
    ...(malformed ? { malformed: true } : {})
  });
  if (!parsed || typeof parsed !== 'object') return refuse('', true);
  if (parsed.chartable === false) {
    const why = (typeof parsed.reason === 'string' && parsed.reason.trim()) ? parsed.reason.trim() : 'This material has no numbers to chart.';
    return { chartable: false, reason: why };
  }
  const str = v => typeof v === 'string' ? v.trim() : '';
  const chartType = str(parsed.chartType);
  if (!CHART_TYPES.includes(chartType)) return refuse('Claude returned an unusable chart. Try again.', true);

  let points = (Array.isArray(parsed.points) ? parsed.points : [])
    .map(p => (p && typeof p === 'object') ? { label: str(p.label), value: p.value } : null)
    .filter(p => p && Number.isFinite(p.value));
  if (chartType === 'pie') points = points.filter(p => p.value >= 0); // a pie of parts can't have negatives
  points = points.slice(0, CHART_POINTS_MAX);

  if (points.length < CHART_POINTS_MIN) return refuse('This material has no numbers to chart.');
  return { chartable: true, chart: { chartType, title: str(parsed.title), valueLabel: str(parsed.valueLabel), points } };
}

/* Round an axis max UP to a clean number on the 1·2·5·10 ramp (87→100, 4.2→5).
   Zero/junk → 1 so nothing downstream divides by zero. */
function niceMax(value) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const frac = v / pow;                       // in [1, 10)
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return nice * pow;
}

/* Linear map of a value from a data domain to a coordinate range. Supports an
   inverted range (SVG y grows downward, so [bottom, top]). */
function chartScale(value, domain, range) {
  const [d0, d1] = domain, [r0, r1] = range;
  if (d1 === d0) return r0;
  return r0 + (value - d0) * (r1 - r0) / (d1 - d0);
}

/* Values → cumulative per-slice angles in degrees. The FINAL boundary is forced
   to exactly 360 rather than trusted from the running sum (float drift). */
function pieAngles(values) {
  const nums = (Array.isArray(values) ? values : []).map(v => (Number.isFinite(v) && v > 0) ? v : 0);
  const total = nums.reduce((a, b) => a + b, 0);
  const out = [];
  let acc = 0;
  for (let i = 0; i < nums.length; i++) {
    const startAngle = total > 0 ? (acc / total) * 360 : (i / nums.length) * 360;
    acc += nums[i];
    const last = i === nums.length - 1;
    const endAngle = last ? 360 : (total > 0 ? (acc / total) * 360 : ((i + 1) / nums.length) * 360);
    out.push({ startAngle, endAngle, pct: total > 0 ? (nums[i] / total) * 100 : 0 });
  }
  return out;
}

/* One pie wedge as an SVG path `d`. 0° at the top, clockwise. A slice > 180°
   sets the large-arc-flag; a full circle (0→360) can't be one arc (start point
   == end point) so it's split into TWO. */
function arcPath(cx, cy, r, startAngle, endAngle) {
  const f = n => Math.round(n * 1000) / 1000;
  const pt = ang => { const a = (ang - 90) * Math.PI / 180; return [f(cx + r * Math.cos(a)), f(cy + r * Math.sin(a))]; };
  const sweep = endAngle - startAngle;
  if (sweep >= 360) {
    const [sx, sy] = pt(startAngle), [mx, my] = pt(startAngle + 180);
    return `M ${sx} ${sy} A ${f(r)} ${f(r)} 0 1 1 ${mx} ${my} A ${f(r)} ${f(r)} 0 1 1 ${sx} ${sy} Z`;
  }
  const [sx, sy] = pt(startAngle), [ex, ey] = pt(endAngle);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${f(cx)} ${f(cy)} L ${sx} ${sy} A ${f(r)} ${f(r)} 0 ${largeArc} 1 ${ex} ${ey} Z`;
}

/* Tidy number for a label (drops trailing zeros). */
function fmtNum(n) { return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : ''; }

/* Monochrome ink-shade ramp for pie slices — distinct grayscale shades so
   adjacent slices read apart, no colour. */
const CHART_PIE_RAMP = ['#111111', '#3b3b3b', '#5e5e5e', '#7f7f7f', '#9c9c9c', '#b3b3b3', '#c7c7c7', '#d8d8d8', '#232323', '#4a4a4a', '#6c6c6c', '#8c8c8c'];

function chartEsc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function barSvg(points, valueLabel, title) {
  const W = Math.max(320, 64 + points.length * 72), H = 300;
  const padL = 48, padR = 16, padT = valueLabel ? 40 : 24, padB = 52;
  const bottom = H - padB, top = padT;
  const maxNice = niceMax(Math.max(...points.map(p => p.value), 0));
  const bw = (W - padL - padR) / points.length;
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const val = maxNice * i / 4, y = chartScale(val, [0, maxNice], [bottom, top]);
    grid += `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`
      + `<text class="chart-axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtNum(val)}</text>`;
  }
  const bars = points.map((p, i) => {
    const x = padL + i * bw + bw * 0.15, w = bw * 0.7, y = chartScale(p.value, [0, maxNice], [bottom, top]);
    const h = Math.max(0, bottom - y), cx = x + w / 2;
    return `<rect class="chart-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"/>`
      + `<text class="chart-val" x="${cx.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle">${fmtNum(p.value)}</text>`
      + `<text class="chart-cat" x="${cx.toFixed(1)}" y="${(bottom + 16).toFixed(1)}" text-anchor="middle">${chartEsc(p.label)}</text>`;
  }).join('');
  const vl = valueLabel ? `<text class="chart-axis-label" x="16" y="16">${chartEsc(valueLabel)}</text>` : '';
  // Comparison is a bar chart's job, so the description names the extremes.
  const maxP = points.reduce((a, b) => b.value > a.value ? b : a);
  const minP = points.reduce((a, b) => b.value < a.value ? b : a);
  const svgTitle = title ? `Bar chart: ${title}` : 'Bar chart';
  const svgDesc = `Bar chart with ${points.length} categories${valueLabel ? `, in ${valueLabel}` : ''}. ` +
    `Highest: ${maxP.label} at ${fmtNum(maxP.value)}. Lowest: ${minP.label} at ${fmtNum(minP.value)}.`;
  const uid = svgUid(`bar|${title}|${valueLabel}|${points.map(p => p.label + ':' + p.value).join(',')}`);
  const titleId = `chart-title-${uid}`, descId = `chart-desc-${uid}`;
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" focusable="false" aria-labelledby="${titleId} ${descId}" aria-describedby="${descId}"><title id="${titleId}">${chartEsc(svgTitle)}</title><desc id="${descId}">${chartEsc(svgDesc)}</desc><g aria-hidden="true">${vl}${grid}<line class="chart-baseline" x1="${padL}" y1="${bottom}" x2="${W - padR}" y2="${bottom}"/>${bars}</g></svg>`;
}

function lineSvg(points, valueLabel, title) {
  const W = Math.max(320, 64 + points.length * 72), H = 300;
  const padL = 48, padR = 16, padT = valueLabel ? 40 : 24, padB = 52;
  const bottom = H - padB, top = padT, n = points.length;
  const maxNice = niceMax(Math.max(...points.map(p => p.value), 0));
  const xAt = i => padL + (n === 1 ? (W - padL - padR) / 2 : (W - padL - padR) * i / (n - 1));
  const yAt = v => chartScale(v, [0, maxNice], [bottom, top]);
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const val = maxNice * i / 4, y = yAt(val);
    grid += `<line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"/>`
      + `<text class="chart-axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${fmtNum(val)}</text>`;
  }
  const coords = points.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p, i) => `<circle class="chart-dot" cx="${xAt(i).toFixed(1)}" cy="${yAt(p.value).toFixed(1)}" r="3"/>`
    + `<text class="chart-cat" x="${xAt(i).toFixed(1)}" y="${(bottom + 16).toFixed(1)}" text-anchor="middle">${chartEsc(p.label)}</text>`).join('');
  const vl = valueLabel ? `<text class="chart-axis-label" x="16" y="16">${chartEsc(valueLabel)}</text>` : '';
  // Trend is a line chart's job: direction, start, end, extremes.
  const first = points[0], last = points[points.length - 1];
  const peak = points.reduce((a, b) => b.value > a.value ? b : a);
  const trough = points.reduce((a, b) => b.value < a.value ? b : a);
  const trend = last.value > first.value ? 'rises' : last.value < first.value ? 'falls' : 'stays flat';
  const svgTitle = title ? `Line chart: ${title}` : 'Line chart';
  const svgDesc = `Line chart with ${points.length} points${valueLabel ? `, in ${valueLabel}` : ''}, from ${first.label} to ${last.label}. ` +
    `Overall ${trend}, from ${fmtNum(first.value)} to ${fmtNum(last.value)}. Peak: ${peak.label} at ${fmtNum(peak.value)}. Lowest: ${trough.label} at ${fmtNum(trough.value)}.`;
  const uid = svgUid(`line|${title}|${valueLabel}|${points.map(p => p.label + ':' + p.value).join(',')}`);
  const titleId = `chart-title-${uid}`, descId = `chart-desc-${uid}`;
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" focusable="false" aria-labelledby="${titleId} ${descId}" aria-describedby="${descId}"><title id="${titleId}">${chartEsc(svgTitle)}</title><desc id="${descId}">${chartEsc(svgDesc)}</desc><g aria-hidden="true">${vl}${grid}<polyline class="chart-line" points="${coords}" fill="none"/>${dots}</g></svg>`;
}

function pieSvg(points, title) {
  const cx = 150, cy = 150, r = 110;
  const swatchX = 300, textX = swatchX + 18;
  const total = points.reduce((a, p) => a + (p.value > 0 ? p.value : 0), 0);
  const angles = pieAngles(points.map(p => p.value));
  const pctOf = v => total > 0 ? Math.round(v / total * 100) : 0;
  /* No DOM here to measure text, so the canvas is sized from an estimate:
     DM Sans at 12px averages ≈ 6.6px per character. Measured on the RAW label
     (what's drawn), not the escaped one. Without this the canvas was a fixed
     440px and long labels — "Indústria e construção — 22%" — were clipped. */
  const widest = points.reduce((m, p) => Math.max(m, (`${p.label} — ${pctOf(p.value)}%`).length), 0);
  const W = Math.max(440, Math.ceil(textX + widest * 6.6 + 16));
  const H = Math.max(300, 44 + points.length * 22 + 16);
  const slices = points.map((p, i) =>
    `<path class="chart-slice" d="${arcPath(cx, cy, r, angles[i].startAngle, angles[i].endAngle)}" fill="${CHART_PIE_RAMP[i % CHART_PIE_RAMP.length]}" stroke="#0A0A0A" stroke-width="1"/>`).join('');
  const legend = points.map((p, i) => {
    const ly = 44 + i * 22;
    return `<rect class="chart-legend-swatch" x="${swatchX}" y="${ly - 10}" width="12" height="12" fill="${CHART_PIE_RAMP[i % CHART_PIE_RAMP.length]}" stroke="#0A0A0A" stroke-width="1"/>`
      + `<text class="chart-legend" x="${textX}" y="${ly}">${chartEsc(p.label)} — ${pctOf(p.value)}%</text>`;
  }).join('');
  // Proportion is a pie chart's job: biggest share, smallest, how lopsided.
  const maxP = points.reduce((a, b) => b.value > a.value ? b : a);
  const minP = points.reduce((a, b) => b.value < a.value ? b : a);
  const svgTitle = title ? `Pie chart: ${title}` : 'Pie chart';
  const svgDesc = `Pie chart with ${points.length} shares of a whole. ` +
    `Largest: ${maxP.label} at ${pctOf(maxP.value)}%. Smallest: ${minP.label} at ${pctOf(minP.value)}%.`;
  const uid = svgUid(`pie|${title}|${points.map(p => p.label + ':' + p.value).join(',')}`);
  const titleId = `chart-title-${uid}`, descId = `chart-desc-${uid}`;
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" role="img" focusable="false" aria-labelledby="${titleId} ${descId}" aria-describedby="${descId}"><title id="${titleId}">${chartEsc(svgTitle)}</title><desc id="${descId}">${chartEsc(svgDesc)}</desc><g aria-hidden="true">${slices}${legend}</g></svg>`;
}

/* A saved chart → SVG string. Shared by the in-app render AND the HTML export. */
/* Duplicated from the map block on purpose: the two pure blocks are sliced
   independently by their test suites and cannot share helpers. */
function svgUid(seed) {
  let h = 2166136261;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

function chartToSvg(chart) {
  if (!chart || typeof chart !== 'object') return '';
  const points = Array.isArray(chart.points) ? chart.points.filter(p => p && Number.isFinite(p.value)) : [];
  if (points.length === 0) return '';
  const valueLabel = typeof chart.valueLabel === 'string' ? chart.valueLabel.trim() : '';
  // The title used to stop here — the renderers never received it, so there was
  // no path for an accessible name to reach the SVG at all.
  const title = typeof chart.title === 'string' ? chart.title.trim() : '';
  if (chart.chartType === 'pie') return pieSvg(points, title);
  if (chart.chartType === 'line') return lineSvg(points, valueLabel, title);
  return barSvg(points, valueLabel, title);
}

/* A saved chart → CSV of the numbers behind it (RFC 4180, same escaper as the
   table). Garbage in → '' out, never throws. */
function chartToCsv(chart) {
  if (!chart || !Array.isArray(chart.points)) return '';
  const field = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const valueHead = (typeof chart.valueLabel === 'string' && chart.valueLabel.trim()) ? chart.valueLabel.trim() : 'value';
  const rows = [['label', valueHead], ...chart.points.map(p => [p.label, p.value])];
  return rows.map(r => r.map(field).join(',')).join('\r\n');
}

/* A saved chart → a self-contained, forced-light HTML page (double-click →
   browser, print-ready). Reuses chartToSvg. Garbage in → '' out. */
/* The chart as a real data table — the accessible companion, and the thing
   that actually reflows on a phone. SVG text is sized in user units and scales
   with the graphic, ignoring the reader's font-size and zoom settings; an HTML
   table respects both. Same rows chartToCsv already produces. */
function chartToTable(chart) {
  if (!chart || typeof chart !== 'object' || !Array.isArray(chart.points)) return '';
  const points = chart.points.filter(p => p && Number.isFinite(p.value));
  if (points.length === 0) return '';
  const valueHead = (typeof chart.valueLabel === 'string' && chart.valueLabel.trim()) ? chart.valueLabel.trim() : 'Value';
  const isPie = chart.chartType === 'pie';
  const total = isPie ? points.reduce((a, p) => a + (p.value > 0 ? p.value : 0), 0) : 0;
  const pct = v => total > 0 ? Math.round(v / total * 100) : 0;

  // A pie whose values ALREADY are percentages shows its shares in the value
  // column; a second one repeats it, header and all ("% | %", 75 | 75%). Decide
  // from the numbers, not from the label text, so it holds in any language.
  const showShare = isPie && !points.every(p => pct(p.value) === Math.round(p.value));

  const head = showShare
    ? `<tr><th scope="col">Label</th><th scope="col">${chartEsc(valueHead)}</th><th scope="col">Share</th></tr>`
    : `<tr><th scope="col">Label</th><th scope="col">${chartEsc(valueHead)}</th></tr>`;
  const body = points.map(p => showShare
    ? `<tr><th scope="row">${chartEsc(p.label)}</th><td>${chartEsc(fmtNum(p.value))}</td><td>${pct(p.value)}%</td></tr>`
    : `<tr><th scope="row">${chartEsc(p.label)}</th><td>${chartEsc(fmtNum(p.value))}</td></tr>`
  ).join('');

  return `<table class="chart-table"><caption>Data</caption><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function chartToHtml(chart, lang) {
  if (!chart || typeof chart !== 'object' || !Array.isArray(chart.points) || chart.points.length === 0) return '';
  const svg = chartToSvg(chart);
  if (!svg) return '';
  const title = (typeof chart.title === 'string' && chart.title.trim()) ? chart.title.trim() : 'Chart';
  return `<!doctype html>
<html lang="${chartEsc((typeof lang === 'string' && lang.trim()) ? lang.trim() : 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${chartEsc(title)}</title>
<style>
  :root { color-scheme: light; }
  html,body { background:#fff; color:#111; margin:0; }
  body { font-family:'DM Sans',system-ui,-apple-system,sans-serif; padding:32px; }
  .chart-doc-title { font-size:20px; font-weight:600; margin:0 0 16px; }
  .chart-svg { max-width:100%; height:auto; }
  .chart-bar { fill:#222; }
  .chart-line { stroke:#222; stroke-width:2; }
  .chart-dot { fill:#222; }
  .chart-grid { stroke:#e6e6e6; stroke-width:1; }
  .chart-baseline { stroke:#111; stroke-width:1; }
  .chart-axis,.chart-cat,.chart-val,.chart-axis-label { fill:#555; font-size:11px; }
  .chart-legend { fill:#111; font-size:12px; }
  .chart-table{width:100%;border-collapse:collapse;font-size:14px;margin-top:22px}
  .chart-table th,.chart-table td{border:1px solid #ccc;padding:8px 10px;text-align:left}
  .chart-table thead th{background:#eee}
  .chart-table caption{text-align:left;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#666;margin:0 0 8px}
  .table-scroll{overflow-x:auto}
</style></head>
<body><h1 class="chart-doc-title">${chartEsc(title)}</h1>${svg}<div class="table-scroll">${chartToTable(chart)}</div></body></html>`;
}

/* ── 9G-impure. The live call ── */

const CHART_SCHEMA = {
  type: 'object',
  properties: {
    chartable: { type: 'boolean' },
    reason: { type: 'string' },
    chartType: { type: 'string', enum: ['bar', 'line', 'pie'] },
    title: { type: 'string' },
    valueLabel: { type: 'string' },
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, value: { type: 'number' } },
        required: ['label', 'value'],
        additionalProperties: false
      }
    }
  },
  required: ['chartable', 'reason', 'chartType', 'title', 'valueLabel', 'points'],
  additionalProperties: false
};

/* One click → one API call. Sonnet, structured output. "not chartable" is an
   honest answer (no numbers), never an exception — same shape as the table. */
async function callClaudeChart(contextText, steering) {
  if (!navigator.onLine) throw offlineError();

  const systemPrompt =
    `You build ONE study chart from a student's own study material — the single most useful quantitative relationship in it. ` +
    `STRICT RULES:\n` +
    `1. Use ONLY numbers the material actually states — NEVER invent, estimate, or round a figure into existence.\n` +
    `2. Pick the type that fits: "bar" to compare categories, "line" for a trend across an ordered sequence (e.g. years), "pie" for parts of a whole that sum to ~100%.\n` +
    `3. "points": 2–12 entries, each { "label", "value" (a number) }, in a sensible order (bar: largest first or the material's order; line: chronological; pie: largest first).\n` +
    `4. "valueLabel" = what the numbers measure (e.g. "% do PIB", "milhões"); "title" names the chart. Same language as the material. Plain text — no markdown.\n` +
    `5. If the material has no real quantitative data to chart, set "chartable" false with a one-line "reason"; leave "chartType" "bar" and "points" empty.`;

  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': getApiKey(),
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        output_config: { format: { type: 'json_schema', schema: CHART_SCHEMA } },
        system: systemPrompt,
        messages: buildChartMessages(contextText, steering)
      })
    });
  } catch (e) {
    throw networkError();
  }

  if (!res.ok) throw await apiError(res);   // one mapping for all 7 call sites (8B)

  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to build a chart from this material.');

  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw transientError('Claude sent back an empty answer. This usually works on a second attempt.');

  let parsed;
  try { parsed = JSON.parse(textBlock.text); } catch (e) { throw transientError('Claude sent back something unreadable. This usually works on a second attempt.'); }
  return parseChartResponse(parsed);
}

/* ── 9G-screen. The Chart tab of the artifacts screen ── */

let chartBusy = false;

function prepChartTab() {
  chartBusy = false;
  document.getElementById('chart-steering').value = '';
  setChartStatus('');
  renderChart();
  setTimeout(() => document.getElementById('chart-steering').focus(), 50);
}

function setChartStatus(msg, kind, retry) { setArtStatus('chart-status', msg, kind, retry); }

function renderChart() {
  const deck = getDeck(currentDeckId);
  const wrap = document.getElementById('chart-result');
  const c = deck ? deck.artifacts.chart : '';
  if (!c || c.type !== 'chart') {
    wrap.innerHTML = `<div class="empty" style="padding:36px 24px">
      <div class="empty-sub" style="margin-bottom:0">No chart yet. Generate one — steer it, or let Claude pick the numbers worth charting.</div>
    </div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="table-result-head">
      ${c.title ? `<h2 class="table-title">${escapeHtml(c.title)}</h2>` : '<span></span>'}
      <div class="dl-btns">
        <button class="btn btn-outline btn-sm" onclick="onDownloadChartHtml()">↓ HTML</button>
        <button class="btn btn-outline btn-sm" onclick="onDownloadChartCsv()">↓ CSV</button>
      </div>
    </div>
    <div class="chart-wrap">${chartToSvg(c)}</div>
    <details class="alt-view">
      <summary>Show the data</summary>
      <div class="table-scroll">${chartToTable(c)}</div>
    </details>`;
}

function onDownloadChartHtml() {
  const deck = getDeck(currentDeckId);
  const c = deck ? deck.artifacts.chart : '';
  if (!c || c.type !== 'chart') { toast('No chart to download'); return; }
  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob([chartToHtml(c, deckLang(currentDeckId))], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-chart-${slug}.html`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Chart downloaded');
}

function onDownloadChartCsv() {
  const deck = getDeck(currentDeckId);
  const c = deck ? deck.artifacts.chart : '';
  if (!c || c.type !== 'chart') { toast('No chart to download'); return; }
  const slug = foldText(deck.name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'deck';
  const blob = new Blob(['﻿' + chartToCsv(c)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `recall-chart-${slug}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  toast('Chart CSV downloaded');
}

async function onGenerateChart() {
  if (chartBusy) return;
  if (!getApiKey()) { openKeyModal(); setChartStatus('Add your API key first, then generate.'); return; }
  const deck = getDeck(currentDeckId);
  const ctx = buildTableContext(deck, cardsForDeck(currentDeckId));
  if (ctx.kind === 'none') { setChartStatus('Add cards or material first.', 'error'); return; }

  const steering = document.getElementById('chart-steering').value;
  chartBusy = true;
  document.getElementById('chart-gen-btn').disabled = true;
  setChartStatus('Asking Claude to build the chart…', 'busy');

  try {
    const r = await callClaudeChart(ctx.text, steering);
    if (!r.chartable) {
      // Broken response → an error you can retry. Honest refusal → a quiet note
      // about the material. Telling a student to "import richer material" when
      // Claude simply returned junk is a lie AND a dead end.
      if (r.malformed) setChartStatus(r.reason, 'error', onGenerateChart);
      else setArtRefusal('chart-status', 'chart', r.reason);
      return;                                                  // saved chart untouched either way
    }
    updateDeckArtifact(currentDeckId, 'chart', { type: 'chart', ...r.chart, steering: steering.trim(), createdAt: Date.now() });
    setChartStatus('');
    renderChart();
    renderArtifactTabDots();
  } catch (err) {
    setChartStatus(err.message || 'Something went wrong.', 'error',
                  err.retryable ? onGenerateChart : null);
  } finally {
    chartBusy = false;
    document.getElementById('chart-gen-btn').disabled = false;
  }
}

/* ----------------------------------------------------------------
   10. SAMPLE DECK
   ---------------------------------------------------------------- */

function loadSampleDeck() {
  const deck = createDeck('Cell Biology', 'Biology');
  [
    ['What is the powerhouse of the cell?', 'The mitochondria — it generates most of the cell\'s ATP through cellular respiration.'],
    ['What process do plants use to turn light into chemical energy?', 'Photosynthesis — turning CO₂ and water into glucose and oxygen using sunlight.'],
    ['What is spaced repetition?', 'A study method that schedules reviews at increasing intervals based on how well you recalled a card.'],
    ['What does DNA stand for?', 'Deoxyribonucleic acid.'],
    ['What is the basic unit of life?', 'The cell.']
  ].forEach(([f, b]) => addCard(deck.id, f, b));
  toast('Sample deck added');
  goDeck(deck.id);
}

/* ----------------------------------------------------------------
   11. PROGRESS / STATS
   ----------------------------------------------------------------
   One screen answering "how am I doing?". Everything here is derived
   from data we already store: card `srs` for the status buckets, and
   the daily `log` for streaks and the activity calendar. */

const HEATMAP_WEEKS = 16;   // ~4 months of activity in the calendar

/* How well a card is known.
   Based on `reps` (correct answers in a row) plus the interval, so a
   single correct answer doesn't jump a card straight to "Familiar".
   Hitting "Again" resets reps to 0, so a forgotten card drops back to
   Learning — exactly what should happen. */
/* cardStatus moved to the 11E pure block (feature #20) — both the home
   dashboard and this screen need it, and 11E is the tested one. */

/* Current streak: consecutive days studied, counting back from today.
   If today has no reviews yet, the streak is still "alive" if yesterday
   had some — so we start counting from yesterday in that case. */
function studyStreak(log) {
  const has = d => (log[dayKey(d)] || 0) > 0;
  const cursor = new Date(); cursor.setHours(0, 0, 0, 0);
  if (!has(cursor)) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (has(cursor)) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

/* ── PURE gamification ───────────────────────────────────────────
   14. GAMIFICATION v1 (feature #32), pure half.

   Built on evidence, and deliberately narrow. Duolingo measured +14% day-14
   retention on the streak-freeze mechanic specifically, because it targets LOSS
   AVERSION — the thing that actually makes people quit is not boredom, it is
   breaking a 40-day streak over one bad Tuesday and deciding it is ruined.

   The SDT caveat from the Feature Ideas note is respected: badges reward
   COMPETENCE (cards actually reviewed, decks actually mastered), never mere
   attendance. Rewarding logins is the version that undermines intrinsic
   motivation; rewarding demonstrated skill does not.

   Sliced by "04 System/(C) test-gamification.mjs" — no DOM, no storage, no clock
   of its own. `now` is always passed in, so streak logic is testable without
   waiting for tomorrow.
   ---------------------------------------------------------------- */

const FREEZE_EVERY = 10;        // days of streak per earned freeze
const MASTERY_MIN_CARDS = 10;   // below this, "90% mastered" is arithmetic, not skill

/* Local day key. Duplicated from dayKey() on purpose: this block is lifted out and
   evaluated standalone by the suite, and naming an outside identifier throws a
   ReferenceError that takes the whole slice down. Same reason section 1E has its own. */
function gDayKey(ts) {
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * Days in a row, counting frozen days as studied.
 *
 * Takes the LIST of frozen days, not a count of remaining freezes. That is the whole
 * correctness argument: a function that consumed from a count would return a smaller
 * number every time it ran on the same history, and the streak would shrink on its
 * own between renders. This is a pure read — call it a thousand times, same answer
 * (pinned by G11).
 */
function calculateStreak(log, frozenDays, now) {
  const frozen = new Set(Array.isArray(frozenDays) ? frozenDays : []);
  const safeLog = log || {};
  const counts = d => (safeLog[gDayKey(d)] || 0) > 0 || frozen.has(gDayKey(d));

  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  // Today with no reviews yet does not mean the streak is broken — it means the day
  // is not over. Anchor on yesterday in that case.
  if (!counts(cursor)) cursor.setDate(cursor.getDate() - 1);

  let streak = 0;
  while (counts(cursor)) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}

/**
 * How many new freezes this streak has earned, and the new high-water mark.
 *
 * earnedAt is what stops the same milestone paying out on every render. It never
 * falls back when a streak breaks: freezes are earned, not rented (G16).
 */
function freezeGrant(streak, earnedAt) {
  const reached = Math.floor((streak || 0) / FREEZE_EVERY) * FREEZE_EVERY;
  const paid = earnedAt || 0;
  if (reached <= paid) return { grant: 0, earnedAt: paid };
  return { grant: (reached - paid) / FREEZE_EVERY, earnedAt: reached };
}

/**
 * Should a freeze be spent right now, and on which day?
 *
 * Pure: it reports a decision and deducts nothing. The caller persists.
 *
 * The rule that matters is the last one. A freeze is only spent when it is actually
 * PROTECTING a streak — if the day before the gap was not studied either, the streak
 * was already gone and spending here buys nothing. Without that guard the bank
 * drains quietly and only shows up weeks later as "where did my freezes go?" (G21).
 */
function freezeSpend(log, frozenDays, freezes, now) {
  if (!freezes || freezes <= 0) return { spend: false, day: '', reason: 'no-freezes' };

  const safeLog = log || {};
  const frozen = new Set(Array.isArray(frozenDays) ? frozenDays : []);
  const counts = d => (safeLog[gDayKey(d)] || 0) > 0 || frozen.has(gDayKey(d));

  const yesterday = new Date(now);
  yesterday.setHours(0, 0, 0, 0);
  yesterday.setDate(yesterday.getDate() - 1);
  if (counts(yesterday)) return { spend: false, day: '', reason: 'nothing-missed' };

  // Was there a live streak immediately before the gap? If not, nothing to protect.
  const before = new Date(yesterday);
  before.setDate(before.getDate() - 1);
  if (!counts(before)) return { spend: false, day: '', reason: 'no-streak-to-protect' };

  return { spend: true, day: gDayKey(yesterday), reason: 'bridged' };
}

/* The badge catalogue. Shapes are geometric primitives drawn as plain SVG at stroke
   weight 1 — Monochrome Futurist, no colour, no animation, nothing that pulses at you
   while you are trying to study. Deliberately NO `color` field: if a badge could
   carry one, one eventually would (G29). */
const BADGES = {
  'reviews-100':  { label: '100 cards reviewed',  shape: 'circle' },
  'reviews-500':  { label: '500 cards reviewed',  shape: 'square' },
  'reviews-1000': { label: '1000 cards reviewed', shape: 'hexagon' },
  'streak-7':     { label: '7-day streak',        shape: 'triangle' },
  'streak-30':    { label: '30-day streak',       shape: 'diamond' },
  'streak-100':   { label: '100-day streak',      shape: 'star' },
  'mastery':      { label: 'Deck mastered',       shape: 'ring' }
};

/**
 * Every badge the current stats satisfy. Returns the FULL set, not the new ones —
 * the caller diffs against what is already stored to find what was just earned.
 *
 * Competence only. There is deliberately no "opened the app 5 days running" badge:
 * that is attendance, and rewarding attendance is the version of this that damages
 * intrinsic motivation.
 */
function checkMilestones(s) {
  const stats = s || {};
  const earned = [];
  const reviews = stats.totalReviews || 0;
  const streak = stats.streak || 0;

  if (reviews >= 100) earned.push('reviews-100');
  if (reviews >= 500) earned.push('reviews-500');
  if (reviews >= 1000) earned.push('reviews-1000');
  if (streak >= 7) earned.push('streak-7');
  if (streak >= 30) earned.push('streak-30');
  if (streak >= 100) earned.push('streak-100');

  // A deck badge needs real mastery over a real deck. 90% of three cards is
  // arithmetic, not competence — without the floor, a 1-card deck mints a badge.
  for (const d of (stats.decks || [])) {
    if ((d.total || 0) >= MASTERY_MIN_CARDS && (d.pct || 0) >= 90) earned.push('master-' + d.id);
  }
  return earned;
}

/**
 * The end-of-session reveal: a small, honest, VARIABLE reward.
 *
 * Variable is the mechanic — a reveal that always says the same sentence is a label,
 * not a reward. Deterministic given a seed so it can be tested (G32) while still
 * differing run to run (G31), because the caller seeds it from the clock.
 *
 * Everything here is computed from data that already exists. The project already
 * rejected the prototype's "Retention 84%" because the log records how many reviews
 * happened, never whether they were right — so retention cannot be computed. A reward
 * that fabricates progress is worse than no reward (G33).
 */
function sessionReward(kind, s, seed) {
  const stats = s || {};
  const reviews = stats.totalReviews || 0;
  const streak = stats.streak || 0;
  const decks = stats.decks || [];

  const options = [];

  options.push({
    kind: 'effort',
    title: 'Session done',
    text: reviews > 0
      ? `That is ${reviews} card${reviews === 1 ? '' : 's'} reviewed all together.`
      : 'First session logged. The next one is where spaced repetition starts paying.'
  });

  if (streak > 0) {
    options.push({
      kind: 'streak',
      title: `${streak}-day streak`,
      // Say how close the next freeze is — a concrete near-term goal beats a vague one.
      text: (() => {
        const toNext = FREEZE_EVERY - (streak % FREEZE_EVERY);
        return toNext === FREEZE_EVERY
          ? 'You just earned a streak freeze.'
          : `${toNext} more day${toNext === 1 ? '' : 's'} until your next streak freeze.`;
      })()
    });
  }

  // A round number you have just crossed is a genuinely rare event, so it is worth
  // surfacing when it happens rather than inventing something.
  if (reviews >= 100) {
    const nextMark = reviews < 500 ? 500 : reviews < 1000 ? 1000 : null;
    options.push({
      kind: 'rare',
      title: 'Milestone',
      text: nextMark
        ? `${reviews} reviewed. ${nextMark - reviews} to go until ${nextMark}.`
        : `${reviews} cards reviewed. That is a lot of retrieval practice.`
    });
  }

  const climbing = decks.filter(d => (d.pct || 0) > 0 && (d.pct || 0) < 100)
                        .sort((a, b) => (b.pct || 0) - (a.pct || 0))[0];
  if (climbing) {
    options.push({
      kind: 'mastery',
      title: climbing.name || 'Deck progress',
      text: `${climbing.pct}% of this deck is now mature. Mastery counts cards you got right after a real gap.`
    });
  }

  const i = Math.abs(Math.floor(seed || 0)) % options.length;
  return options[i];
}

/* ── END PURE gamification ── */

/* ── Gamification, impure half (feature #32) ──────────────────────

   One entry point. Called on load and after every session, it does the whole cycle:
   spend a freeze if a day was missed, grant freezes the streak has earned, and record
   any newly satisfied badges. Everything it writes goes through saveData, so the #19
   write lock still guards it. */

/** Roll the current stats up into the shape the pure functions expect. */
function gamificationStats(data) {
  const g = normalizeGamification(data.gamification);
  const totalReviews = Object.values(data.log || {}).reduce((a, b) => a + (Number(b) || 0), 0);
  const decks = (data.decks || []).map(d => {
    const m = deckMastery((data.cards || []).filter(c => c.deckId === d.id));
    return { id: d.id, name: d.name, total: m.total, pct: m.pct };
  });
  return { totalReviews, streak: calculateStreak(data.log, g.frozenDays, Date.now()), decks };
}

/**
 * Apply every gamification rule and persist what changed.
 *
 * Returns what was newly earned so a caller can announce it. Writes only when
 * something actually changed — a no-op save on every render would churn localStorage
 * and, worse, hide a real change in the noise.
 */
function syncGamification() {
  const data = loadData();
  const g = normalizeGamification(data.gamification);
  let next = { ...g, frozenDays: [...g.frozenDays], badges: [...g.badges] };
  let changed = false;

  // 1. A missed day, bridged. Done before the streak is read so the grant below sees
  //    the repaired streak rather than a broken one.
  const spend = freezeSpend(data.log, next.frozenDays, next.freezes, Date.now());
  if (spend.spend) {
    next.freezes -= 1;
    next.frozenDays = [...next.frozenDays, spend.day];
    changed = true;
  }

  // 2. Freezes the streak has earned.
  const streak = calculateStreak(data.log, next.frozenDays, Date.now());
  const grant = freezeGrant(streak, next.earnedAt);
  if (grant.grant > 0) {
    next.freezes += grant.grant;
    next.earnedAt = grant.earnedAt;
    changed = true;
  }

  // 3. Badges. checkMilestones returns everything currently satisfied; the diff
  //    against what is stored is what is NEW.
  const stats = { ...gamificationStats(data), streak };
  const earnedNow = checkMilestones(stats);
  const fresh = earnedNow.filter(id => !next.badges.includes(id));
  if (fresh.length) {
    next.badges = [...next.badges, ...fresh];
    changed = true;
  }

  if (changed) saveData({ ...data, gamification: next });
  return { newBadges: fresh, freezeSpent: spend.spend ? spend.day : '', streak, gamification: next };
}

/** Human label for a badge id, including the per-deck mastery ones. */
function badgeLabel(id, data) {
  if (BADGES[id]) return BADGES[id].label;
  if (id.startsWith('master-')) {
    const deck = (data.decks || []).find(d => d.id === id.slice(7));
    return deck ? 'Mastered · ' + deck.name : 'Deck mastered';
  }
  return id;
}

function badgeShape(id) {
  return (BADGES[id] || BADGES.mastery).shape;
}

/* Geometric primitives at stroke weight 1. No fills, no colour, no animation —
   Monochrome Futurist, and nothing that pulses while you are trying to study. */
const BADGE_SHAPES = {
  circle:   '<circle cx="18" cy="18" r="12"/>',
  square:   '<rect x="7" y="7" width="22" height="22"/>',
  hexagon:  '<path d="M18 5l11 6.5v13L18 31 7 24.5v-13z"/>',
  triangle: '<path d="M18 6l12 22H6z"/>',
  diamond:  '<path d="M18 5l13 13-13 13L5 18z"/>',
  star:     '<path d="M18 5l3.8 9.2 9.9.8-7.5 6.5 2.3 9.7-8.5-5.2-8.5 5.2 2.3-9.7L4.3 15l9.9-.8z"/>',
  ring:     '<circle cx="18" cy="18" r="12"/><circle cx="18" cy="18" r="6"/>'
};

function badgeSvg(id) {
  return `<svg viewBox="0 0 36 36" aria-hidden="true" class="badge-icon">${
    BADGE_SHAPES[badgeShape(id)] || BADGE_SHAPES.circle}</svg>`;
}

/**
 * The end-of-session reveal, painted into whichever done-panel just appeared.
 *
 * Seeded from the clock so the reward varies run to run, which is the entire
 * mechanic — a reveal that always says the same sentence is a label, not a reward.
 */
function renderSessionReward(containerId) {
  const box = document.getElementById(containerId);
  if (!box) return;
  const result = syncGamification();
  const data = loadData();
  const reward = sessionReward('review', { ...gamificationStats(data), streak: result.streak },
                               Math.floor(Date.now() / 1000));

  const badges = result.newBadges.map(id => `
      <div class="badge-new">${badgeSvg(id)}<span>${escapeHtml(badgeLabel(id, data))}</span></div>`).join('');

  box.innerHTML = `
    <div class="reward-panel">
      <div class="reward-title">${escapeHtml(reward.title)}</div>
      <p class="reward-text">${escapeHtml(reward.text)}</p>
      ${result.freezeSpent ? '<p class="reward-freeze">A streak freeze covered the day you missed.</p>' : ''}
      ${badges ? `<div class="badge-row">${badges}</div>` : ''}
    </div>`;
}

/* Longest streak ever: the biggest run of back-to-back logged days. */
function longestStreak(log) {
  const days = Object.keys(log).filter(k => log[k] > 0).sort();
  if (!days.length) return 0;
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + 'T00:00:00');
    const cur = new Date(days[i] + 'T00:00:00');
    if (Math.round((cur - prev) / DAY) === 1) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  return best;
}

function reviewsInLastDays(log, n) {
  let sum = 0;
  const d = new Date(); d.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) { sum += log[dayKey(d)] || 0; d.setDate(d.getDate() - 1); }
  return sum;
}

function goStats() {
  setCrumb('');
  setActiveTab('stats');
  renderStats();
  showScreen('stats');
}

function renderStats() {
  const data = loadData();
  const cards = data.cards;
  const log = data.log || {};
  const body = document.getElementById('stats-body');

  const totalReviews = Object.values(log).reduce((a, b) => a + b, 0);
  if (cards.length === 0 && totalReviews === 0) {
    body.innerHTML = `<div class="empty">
      <div class="empty-title">No progress yet</div>
      <div class="empty-sub">Study a deck and your streak, activity, and card stats will show up here.</div>
      <div class="empty-actions"><button class="btn btn-primary" onclick="goDecks()">Go to your decks</button></div>
    </div>`;
    return;
  }

  const buckets = { new: 0, learning: 0, young: 0, mature: 0 };
  cards.forEach(c => { buckets[cardStatus(c)]++; });
  const due = cards.filter(c => (c.srs?.due ?? 0) <= Date.now()).length;

  // Gamification lives HERE and at session end — never on Home. The Focus layout
  // (#30) exists to answer information overload; putting badges on it would undo
  // the feature that was built two days earlier.
  const g = syncGamification();

  // THE STREAK SHOWN HERE MUST BE THE FREEZE-AWARE ONE. studyStreak() predates #32
  // and does not know frozen days exist, so it reported 3 while the reward panel and
  // the freeze grant both said 40 — two different streaks on one screen, and the
  // freeze feature invisible exactly where someone would look for it. Caught by
  // screenshotting Progress, not by any check.
  body.innerHTML =
    statCardsHtml(g.streak, longestStreak(log), log[dayKey(Date.now())] || 0, reviewsInLastDays(log, 7)) +
    gamificationSectionHtml(g.gamification, data) +
    statusSectionHtml(buckets, cards.length, due) +
    reviewsBarHtml(log) +
    weakSpotsHtml(cards, data.decks);
}

/* Badges and streak freezes on the Progress screen.

   Deliberately understated: earned badges only, no greyed-out "locked" grid. A wall
   of things you have not done is a guilt board, and this feature is supposed to help
   someone keep going, not itemise what they are missing. */
function gamificationSectionHtml(g, data) {
  const freezes = g.freezes || 0;
  const badges = g.badges || [];
  if (!freezes && !badges.length && !(g.frozenDays || []).length) return '';

  const badgeHtml = badges.map(id => `
      <div class="badge" title="${escapeHtml(badgeLabel(id, data))}">
        ${badgeSvg(id)}<span class="badge-label">${escapeHtml(badgeLabel(id, data))}</span>
      </div>`).join('');

  const used = (g.frozenDays || []).length;
  return `
    <section class="stats-section">
      <h2 class="stats-h2">Milestones</h2>
      <div class="freeze-line">
        <span class="freeze-n">${freezes}</span>
        <span class="freeze-l">streak freeze${freezes === 1 ? '' : 's'} banked${
          used ? ` · ${used} used so far` : ''}</span>
      </div>
      <p class="freeze-sub">You earn one every ${FREEZE_EVERY} days. If you miss a day, one is
        spent automatically so the streak survives.</p>
      ${badgeHtml ? `<div class="badge-grid">${badgeHtml}</div>` : ''}
    </section>`;
}

/* Reviews per day for the last two weeks. Bars are pure CSS heights — no
   library, same call as every chart in this app. */
const REVIEW_BAR_DAYS = 14;

function reviewsBarHtml(log) {
  const days = reviewsPerDay(log, REVIEW_BAR_DAYS, Date.now());
  const peak = Math.max(1, ...days.map(d => d.n));
  const bars = days.map(d => {
    const h = Math.round(d.n / peak * 100);
    return `<div class="rbar-col" title="${d.key} · ${d.n} review${d.n === 1 ? '' : 's'}">
      <div class="rbar" style="height:${d.n === 0 ? 2 : h}%${d.n === 0 ? ';opacity:.35' : ''}"></div>
    </div>`;
  }).join('');
  return `<div class="stats-section">
    <h2>Reviews per day <span class="section-note">last ${REVIEW_BAR_DAYS} days</span></h2>
    <div class="rbar-chart">${bars}</div>
  </div>`;
}

/* Cards you keep getting wrong. Empty is the good case, so it says so rather
   than rendering a blank panel. */
function weakSpotsHtml(cards, decks) {
  const weak = weakSpots(cards, decks);
  if (weak.length === 0) {
    return `<div class="stats-section">
      <h2>Weak spots</h2>
      <div class="stat-card-sub">Nothing has been missed ${WEAK_MIN_LAPSES}+ times. That is the good outcome.</div>
    </div>`;
  }
  const rows = weak.map(w => `
    <div class="weak-item">
      <div class="weak-q">${escapeHtml(w.front)}</div>
      <div class="weak-meta">
        <span class="weak-deck">${escapeHtml(w.deckName)}</span>
        <span class="wrong-badge">✗ ${w.lapses} wrong</span>
      </div>
    </div>`).join('');
  return `<div class="stats-section">
    <h2>Weak spots <span class="section-note">missed ${WEAK_MIN_LAPSES}+ times</span></h2>
    <div class="weak-list">${rows}</div>
    <button class="btn btn-primary" style="margin-top:16px" onclick="drillWeakSpots()">Drill these ${weak.length} card${weak.length === 1 ? '' : 's'}</button>
  </div>`;
}

/* Drill = a cram session over exactly the weak cards. Cram already ignores the
   SM-2 schedule and does not write to it, which is precisely what drilling
   wants — so this reuses it rather than inventing a fourth study mode. */
function drillWeakSpots() {
  const data = loadData();
  const ids = weakSpots(data.cards, data.decks).map(w => w.id);
  if (ids.length === 0) { toast('No weak spots to drill'); return; }
  startCram(ids);
}

function statCardsHtml(cur, best, today, week) {
  const fire = cur > 0 ? '🔥 ' : '';
  const card = (n, label) => `<div class="stat-card"><div class="stat-card-n">${n}</div><div class="stat-card-l">${label}</div></div>`;
  return `<div class="stat-grid">
    <div class="stat-card"><div class="stat-card-n">${fire}${cur}<span class="unit">d</span></div><div class="stat-card-l">Current streak</div></div>
    <div class="stat-card"><div class="stat-card-n">${best}<span class="unit">d</span></div><div class="stat-card-l">Longest streak</div></div>
    ${card(today, 'Reviews today')}
    ${card(week, 'Last 7 days')}
  </div>`;
}

function statusSectionHtml(b, total, due) {
  const pct = n => total > 0 ? (n / total * 100) : 0;
  const seg = (cls, n) => n > 0 ? `<div class="seg ${cls}" style="width:${pct(n)}%"></div>` : '';
  const li = (cls, label, n) => `<span class="legend-item"><span class="legend-dot ${cls}"></span>${label} <b>${n}</b></span>`;
  return `<div class="stats-section">
    <h2>Cards by status</h2>
    <div class="statusbar">${seg('seg-new', b.new)}${seg('seg-learning', b.learning)}${seg('seg-young', b.young)}${seg('seg-mature', b.mature)}</div>
    <div class="status-legend">
      ${li('seg-new', 'New', b.new)}${li('seg-learning', 'Learning', b.learning)}${li('seg-young', 'Familiar', b.young)}${li('seg-mature', 'Mastered', b.mature)}
    </div>
    <div class="stat-card-sub" style="margin-top:14px">${due} card${due === 1 ? '' : 's'} due for review right now.</div>
  </div>`;
}

function hmClass(n) {
  if (n <= 0) return 'hm-0';
  if (n < 4) return 'hm-1';
  if (n < 8) return 'hm-2';
  if (n < 15) return 'hm-3';
  return 'hm-4';
}

/* Just the grid. Extracted (feature #20) because the heatmap moved to the home
   dashboard — one generator, so the two callers cannot drift. */
function heatmapGridHtml(log) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayTs = today.getTime();
  // End on the Saturday of this week so every column is a whole week.
  const end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay()));
  const totalDays = HEATMAP_WEEKS * 7;
  const start = new Date(end);
  start.setDate(start.getDate() - (totalDays - 1));  // lands on a Sunday

  let cells = '';
  const cur = new Date(start);
  for (let i = 0; i < totalDays; i++) {
    const ts = cur.getTime();
    if (ts > todayTs) {
      cells += `<div class="hm-cell hm-empty"></div>`;         // future day — blank
    } else {
      const key = dayKey(ts);
      const n = log[key] || 0;
      cells += `<div class="hm-cell ${hmClass(n)}" title="${key} · ${n} review${n === 1 ? '' : 's'}"></div>`;
    }
    cur.setDate(cur.getDate() + 1);
  }
  return `<div class="heatmap-wrap"><div class="heatmap">${cells}</div></div>`;
}

/* ----------------------------------------------------------------
   11C. BACKUP (export / import a file)
   ----------------------------------------------------------------
   All your data lives in this browser's localStorage — clearing the
   browser would wipe it. Export writes decks + cards + study log to a
   JSON file you download; import reads one back. The API key is stored
   separately and is deliberately NOT included, so a backup file is safe
   to keep around. */

function exportData() {
  const data = loadData();
  if (data.decks.length === 0 && data.cards.length === 0) { toast('Nothing to back up yet'); return; }

  // A small wrapper so we can recognise + version the file on import.
  const payload = { app: 'recall', version: 1, exportedAt: new Date().toISOString(), data };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recall-backup-${dayKey(Date.now())}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  // Its own key, not part of `recall.data`: this is a fact about your habits,
  // not about your library, and it has to survive the import that replaces
  // recall.data wholesale.
  localStorage.setItem(BACKUP_AT_KEY, new Date().toISOString());
  renderBackupNudge();
  toast('Backup downloaded');
}

/* The raw bytes, exactly as stored, for when the save cannot be parsed. This is
   the difference between "your data is gone" and "your data is in this file". */
function downloadRawData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) { toast('There is nothing stored to download'); return; }
  downloadFile('recall-raw-data-' + dayKey(Date.now()) + '.txt',
               new Blob([raw], { type: 'text/plain' }));
  toast('Raw data downloaded — keep this file');
}

function importData() { document.getElementById('import-file').click(); }

function onImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';   // reset so re-picking the same file still fires onchange
  if (!file) return;

  const reader = new FileReader();
  reader.onerror = () => toast('Could not read that file');
  reader.onload = () => {
    // All the judgement lives in parseBackupFile (section 1B) so it can be tested
    // without a browser — the same split as parseSavedData / loadData.
    const result = parseBackupFile(reader.result);
    if (!result.ok) {
      toast(result.reason === 'not-json' ? 'That file isn\'t valid JSON'
          : result.reason === 'empty'    ? 'That backup is empty — importing it would erase everything'
          :                                'That doesn\'t look like a Recall backup');
      return;
    }

    const incoming = result.data;
    const deckN = incoming.decks.length;
    const cardN = incoming.cards.length;
    const current = loadData();
    const hasData = current.decks.length > 0 || current.cards.length > 0;
    const msg = hasData
      // "assignments" added with feature #27: import is the other door into
      // saveData({force:true}), and it under-reported what it replaces exactly the way
      // restorePlan did. When a bug is found at one call site, its siblings are the
      // first place to look — offline lived in 7 places, "Try again" in 4.
      ? `Import ${deckN} deck${deckN === 1 ? '' : 's'} and ${cardN} card${cardN === 1 ? '' : 's'}? This REPLACES your current decks, cards, assignments, and history.`
      : `Import ${deckN} deck${deckN === 1 ? '' : 's'} and ${cardN} card${cardN === 1 ? '' : 's'}?`;
    if (!confirm(msg)) return;

    // force: importing IS the user saying "replace everything", and it is the
    // only way to recover from a save that can no longer be read.
    // (parseBackupFile defaulted the log; srs is backfilled by loadData on read.)
    saveData(incoming, { force: true });
    toast(`Imported ${deckN} deck${deckN === 1 ? '' : 's'}`);
    goDecks();
  };
  reader.readAsText(file);
}

/* ----------------------------------------------------------------
   11D. SPEECH (read cards aloud) — pure logic
   ----------------------------------------------------------------
   Feature #18. Recall reads the card out loud using `speechSynthesis`,
   a BROWSER api — free, offline, no key. Same family as localStorage,
   nothing at all like the Claude API (which costs money per call).

   The engine itself is three lines. Everything here exists because
   those three lines behave badly at the edges: the voice reads markdown
   punctuation out loud as words, browsers report language tags in
   inconsistent formats, and the voice list is empty on first call.

   This block is pure (no browser, no state) so it can be unit-tested by
   `04 System/(C) test-speech.mjs`. The speaking itself is below in the
   impure half, and is verified in the browser instead. */

// English first and default: Diogo's call 2026-07-26 — all decks in English,
// cards as well as voice. The other languages stay available but unused for now.
const SPEECH_LANGS = [
  { code: 'en-US', label: 'English (US)' },
  { code: 'pt-PT', label: 'Português (PT)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' }
];
const SPEECH_DEFAULT_LANG = 'en-US';
const SPEECH_MAX_CHARS = 600;   // one comfortable listen; longer answers get cut on a sentence

/* Browsers report language tags inconsistently: 'pt-PT', 'pt_PT', 'PT-pt'.
   Reduce any of them to one comparable form before matching. */
function langKey(v) {
  return String(v == null ? '' : v).trim().replace(/_/g, '-').toLowerCase();
}

/* Any stored or junk language → one we actually offer. Old decks predate
   the `lang` field entirely, so `undefined` must land on Portuguese. */
function normalizeLang(lang) {
  const key = langKey(lang);
  const hit = SPEECH_LANGS.find(l => l.code.toLowerCase() === key);
  return hit ? hit.code : SPEECH_DEFAULT_LANG;
}

/* Make a card speakable. Without this the voice literally pronounces
   "asterisk asterisk" around bold text and "hash" before a heading. */
function cleanForSpeech(text) {
  if (typeof text !== 'string') return '';

  const out = text
    .replace(/^[ \t]*[#>\-•*+]+[ \t]*/gm, '')  // heading / bullet markers at line starts
    .replace(/\*\*/g, '')                       // bold
    .replace(/[*_`]/g, '')                      // italics, code ticks
    .replace(/\s+/g, ' ')                       // newlines + runs → single spaces
    .trim();

  if (out.length <= SPEECH_MAX_CHARS) return out;

  // Too long: prefer stopping on a full stop, so it ends like a sentence
  // rather than trailing off. Failing that, at least never cut mid-word.
  const cut = out.slice(0, SPEECH_MAX_CHARS);
  const lastStop = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'));
  if (lastStop > 0) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/* Choose a voice for a language.
   1. exact match ('pt-PT' → the pt-PT voice)
   2. same language, other region ('pt-PT' → 'pt-BR') — a Brazilian voice
      reading European Portuguese is imperfect, but silence is worse
   3. null → "let the browser pick its default". This is also the answer
      on first call, when getVoices() has not loaded yet: speaking with
      the default voice beats not speaking at all. */
function pickVoice(voices, lang) {
  if (!Array.isArray(voices) || voices.length === 0) return null;
  const want = langKey(normalizeLang(lang));
  const base = want.split('-')[0];
  const usable = voices.filter(v => v && typeof v.lang === 'string');
  return usable.find(v => langKey(v.lang) === want)
      || usable.find(v => langKey(v.lang).split('-')[0] === base)
      || null;
}

/* Which face to read, already cleaned. This tiny seam is what lets the
   whole speak-on-flip flow be tested without a browser. */
function speechTextFor(card, isFlipped) {
  if (!card || typeof card !== 'object') return '';
  return cleanForSpeech(isFlipped ? card.back : card.front);
}

/* ── Kokoro clip naming (2026-07-26) ─────────────────────────────
   The browser speech engine is gone. Audio is now pre-generated ahead of time
   by 04 System/(C) kokoro-build-audio.py and played back from a file, which is
   why there is no latency and no pre-fetch queue in this feature.

   The bridge between the two halves is a FILENAME. The app decides every name;
   the Python side decides none. That is deliberate: two copies of the naming
   logic in two languages would drift, and the symptom of drift is total silence
   with no error — the worst failure mode this app has.
   See 01 Design/(C) Audio TTS — Kokoro engine.md */

/* The Test Voice sentences live here rather than inside onTestVoice() so that
   audioManifest() can include them. Otherwise Test Voice is the one button
   guaranteed to be broken on day one, before any deck has audio. */
const SPEECH_SAMPLES = {
  'en-US': 'This is the voice that will read your cards aloud.',
  'pt-PT': 'Isto é a voz que vai ler os teus cartões em português.',
  'es-ES': 'Esta es la voz que leerá tus tarjetas en voz alta.',
  'fr-FR': 'Voici la voix qui lira vos cartes à voix haute.'
};

/* Which Kokoro voice reads which language, plus the language code Kokoro's own
   API wants ('en-us', not 'en-US'). Adding a language later is ONE line here.
   es-ES and fr-FR are deliberately absent: each needs a verified Kokoro voice
   name, for decks that do not exist yet. */
const KOKORO_VOICES = {
  'en-US': { voice: 'af_heart', lang: 'en-us' },
  'pt-PT': { voice: 'pf_dora', lang: 'pt-br' }   // Brazilian — the only Portuguese Kokoro has
};

/* FNV-1a, 32-bit, as 8 hex characters.
   A hash turns any string into a short fixed-length fingerprint: the same text
   always gives the same fingerprint, and different text almost always gives a
   different one. This one is not cryptographic and does not need to be — its
   only job is naming files. Math.imul is here because it is the one way to get
   a true 32-bit integer multiply in JavaScript. */
function fnv1a(str) {
  const s = typeof str === 'string' ? str : '';
  let h = 0x811c9dc5;                  // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);      // FNV prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/* A clip's filename stem: voice, fingerprint, text length.
   Edit a card and both the fingerprint and usually the length change, so the
   old clip is simply never asked for again. That is why this feature contains
   no staleness bookkeeping at all — the cache invalidates itself.
   Expects text that has ALREADY been through cleanForSpeech(). */
function speechClipId(text, voice) {
  const t = typeof text === 'string' ? text : '';
  const v = (typeof voice === 'string' && voice) ? voice : 'none';
  return v + '-' + fnv1a(t) + '-' + t.length;
}

/* Shared lookup for the two accessors below. Tolerates the case and underscore
   forms normalizeLang accepts, but does NOT fall back to English: silently
   reading a Spanish card in an American voice is worse than saying plainly
   that there is no voice for it. */
function kokoroFor(lang) {
  if (typeof lang !== 'string') return null;
  const key = lang.trim().replace(/_/g, '-').toLowerCase();
  const code = Object.keys(KOKORO_VOICES).find(c => c.toLowerCase() === key);
  return code ? KOKORO_VOICES[code] : null;
}

/* The Kokoro voice for a language, or null when we have none. */
function voiceForLang(lang) {
  const hit = kokoroFor(lang);
  return hit ? hit.voice : null;
}

/* The language code Kokoro's API expects, or null. */
function kokoroLangFor(lang) {
  const hit = kokoroFor(lang);
  return hit ? hit.lang : null;
}

/* Walk every card face in every deck and collect the clips needed, as
   { h: filename stem, t: cleaned text, v: Kokoro voice, l: Kokoro lang }.

   `includeSamples` is the only difference between the generator's view (needs
   the Test Voice sentences too) and the nudge's view (counts cards only, so
   "N missing" never includes sentences that are not cards). */
function collectClips(library, includeSamples) {
  const decks = (library && Array.isArray(library.decks)) ? library.decks : [];
  const cards = (library && Array.isArray(library.cards)) ? library.cards : [];
  const out = [];
  const seen = new Set();

  function add(rawText, lang) {
    const v = voiceForLang(lang);
    if (!v) return;                    // no Kokoro voice for this language — nothing to render
    const t = cleanForSpeech(rawText);
    if (!t) return;                    // blank face: never spoken, so never generated
    const h = speechClipId(t, v);
    if (seen.has(h)) return;           // identical text + voice is one clip, not two
    seen.add(h);
    out.push({ h, t, v, l: kokoroLangFor(lang) });
  }

  decks.forEach(d => {
    if (!d) return;
    const lang = normalizeLang(d.lang);
    cards.forEach(c => {
      if (!c || c.deckId !== d.id) return;
      add(c.front, lang);
      add(c.back, lang);
    });
  });

  if (includeSamples) {
    Object.keys(SPEECH_SAMPLES).forEach(code => add(SPEECH_SAMPLES[code], code));
  }
  return out;
}

/* Everything the generator must produce. This is the ENTIRE interface to the
   Python side: because both `h` and `t` are resolved here, the generator never
   cleans text and never hashes anything, so there is no second copy of that
   logic to drift. */
function audioManifest(library) {
  return collectClips(library, true);
}

/* Card clips only — what the decks-screen nudge counts. */
function cardClips(library) {
  return collectClips(library, false);
}

/* ── 11D-impure ──────────────────────────────────────────────────
   Everything below touches the browser, so the test suite stops here.
   Verified by using it, not by node. */

const SPEAK_PREF_KEY = 'recall.speak';   // global on/off, like the API key — not deck data

/* Playing a file needs only Audio(), which every browser worth supporting has,
   so this is now always true. Kept as a function because refreshSpeechUi()
   still asks, and because it documents what the feature depends on.
   The old `voiceschanged` / getVoices() machinery is gone with the engine —
   TRAP 1 in the v1 design note no longer exists. */
function speechSupported() {
  return typeof Audio === 'function';
}

/* audio/clips.js is written by the generator and sets:
     window.RECALL_CLIPS = { ext: 'mp3', ids: ['af_heart-3f2a91c4-142', …] }
   index.html loads it with a <script> tag rather than fetching it, because
   (measured 2026-07-26, real Chrome, real file:// page) fetch() is blocked on
   file:// while <script> and <audio> are not. So the app can PLAY a local file
   but cannot CHECK for one — this list is how it knows what exists.
   File absent → undefined → cleanly means "nothing generated yet". */
function clipExt() {
  const c = window.RECALL_CLIPS;
  return (c && typeof c.ext === 'string' && c.ext) ? c.ext : 'mp3';
}
const clipIds = new Set(
  (window.RECALL_CLIPS && Array.isArray(window.RECALL_CLIPS.ids)) ? window.RECALL_CLIPS.ids : []
);
function hasClip(id) { return clipIds.has(id); }

function autoSpeakOn() { return localStorage.getItem(SPEAK_PREF_KEY) === '1'; }
function setAutoSpeak(on) { localStorage.setItem(SPEAK_PREF_KEY, on ? '1' : '0'); }

/* The clip currently playing, held in a variable so stopSpeech() can reach it
   (and so nothing collects it mid-sentence — same reasoning as the utterance
   this replaced). */
let currentAudio = null;

/* Speak a card face by playing its pre-generated Kokoro clip. Stops anything
   already playing first — otherwise you flip a card and the old question keeps
   talking over the new answer. */
function speak(text, lang) {
  if (!speechSupported()) return false;
  const say = cleanForSpeech(text);
  if (!say) return false;

  const code = normalizeLang(lang);
  const v = voiceForLang(code);
  if (!v) {
    // es-ES / fr-FR are still in the dropdown but have no Kokoro voice mapped.
    toast('No voice for ' + code + ' yet — English and Portuguese only');
    return false;
  }

  const id = speechClipId(say, v);

  /* ERROR PATH 1 — this clip was never generated. Say so out loud. A button
     that does nothing with no explanation is exactly the failure that cost
     three rounds of blind patching on 2026-07-26. */
  if (!hasClip(id)) {
    toast('No audio for this card — run the generator.');
    return false;
  }

  stopSpeech();
  const audio = new Audio('audio/' + id + '.' + clipExt());

  /* ERROR PATH 2 — the clip is listed but will not load: pruned behind the
     app's back, or corrupt. Surface the real reason. */
  audio.onerror = () => {
    const errCode = audio.error && audio.error.code;
    console.warn('Clip failed to load:', id, 'error code', errCode);
    toast('Could not play that clip (error ' + errCode + ')');
  };

  currentAudio = audio;
  audio.play().catch(e => {
    // We interrupt playback on every flip, rating and screen exit, and the
    // browser rejects the still-pending play() promise with AbortError when we
    // do. That one is ours and is expected. Everything else must be visible.
    if (e && e.name === 'AbortError') return;
    console.warn('Audio play failed:', e);
    toast('Could not read that aloud (' + ((e && e.name) || 'unknown') + ')');
  });
  return true;
}

function stopSpeech() {
  if (!currentAudio) return;
  const audio = currentAudio;
  currentAudio = null;      // cleared first, so the AbortError below is expected
  try {
    audio.pause();
    audio.currentTime = 0;
  } catch (e) {
    // pause() and currentTime can throw if the element never finished loading.
    // Logged, not toasted: stopping is not something the user asked to see.
    console.warn('Could not stop playback cleanly:', e);
  }
}

function deckLang(deckId) {
  const deck = getDeck(deckId);
  return normalizeLang(deck && deck.lang);
}

/* --- review + cram wiring ---------------------------------------
   renderReview()/renderCram() are called on exactly three events: a new
   card, a flip, and a rating (which lands on a new card). So auto-speak
   hangs off the render and covers all of them with one hook.

   TRAP 2: Safari/iOS only speaks inside a user gesture. The session's
   first speak() runs synchronously from the Study/Cram button tap via
   startReview() → renderReview(), which unlocks speech for the session. */
function autoSpeakReview() {
  if (autoSpeakOn()) speakReviewFace();
}
function speakReviewFace() {
  speak(speechTextFor(currentReviewCard(), isFlipped), deckLang(currentDeckId));
}
function autoSpeakCram() {
  if (autoSpeakOn()) speakCramFace();
}
function speakCramFace() {
  speak(speechTextFor(currentCramCard(), cramFlipped), deckLang(currentDeckId));
}

/* Show or hide every speech control based on engine support, and keep the
   toggle in sync with the stored preference. */
function refreshSpeechUi() {
  const on = autoSpeakOn();
  const supported = speechSupported();
  document.querySelectorAll('.speak-btn').forEach(b => {
    b.style.display = supported ? '' : 'none';
  });
  const row = document.getElementById('speak-toggle-row');
  if (row) row.style.display = supported ? '' : 'none';
  const box = document.getElementById('speak-toggle');
  if (box) box.checked = on;
}

function onToggleAutoSpeak() {
  const box = document.getElementById('speak-toggle');
  const on = !!(box && box.checked);
  setAutoSpeak(on);
  if (!on) stopSpeech();
  toast(on ? 'Cards will be read aloud' : 'Read aloud off');
}

/* Fill a <select> with the offered languages. */
function fillLangSelect(el, selected) {
  if (!el) return;
  const code = normalizeLang(selected);
  el.innerHTML = SPEECH_LANGS
    .map(l => `<option value="${l.code}"${l.code === code ? ' selected' : ''}>${escapeHtml(l.label)}</option>`)
    .join('');
}

function onChangeDeckLang() {
  const el = document.getElementById('deck-lang');
  if (!el || !currentDeckId) return;
  updateDeckLang(currentDeckId, el.value);
  toast('Voice set to ' + el.options[el.selectedIndex].text);
}

/* Say one sentence in the deck's language, so you can judge the voice
   before committing to a whole study session with it. */
function onTestVoice() {
  const code = deckLang(currentDeckId);
  // speak() already toasts the specific reason it could not play (no voice for
  // this language, or the clip is not generated yet), so there is nothing to
  // add here — a second generic toast on top would only obscure it.
  speak(SPEECH_SAMPLES[code], code);
}

/* ----------------------------------------------------------------
   11E. DASHBOARD + WEAK SPOTS (feature #20) — pure
   ----------------------------------------------------------------
   Everything the home dashboard and the progress screen compute, with
   no browser and no state, so `04 System/(C) test-dashboard.mjs` can
   check it. Adapted from the original web concept,
   01 Design/(C) Recall-standalone.html. */

const WEAK_MIN_LAPSES = 3;    // "missed 3+ times" — the prototype's own threshold
const WEAK_LIMIT = 8;         // a wall of failures discourages; a short list acts
const SECONDS_PER_CARD = 20;  // rough, and the copy says "about"

/* How well a card is known. Based on `reps` (correct answers in a row) plus the
   interval, so one correct answer doesn't jump a card straight to "Familiar".
   Hitting "Again" resets reps to 0, so a forgotten card drops back to Learning. */
function cardStatus(card) {
  const s = (card && card.srs) || {};
  if (!s.last) return 'new';                     // never reviewed
  if ((s.reps || 0) < 2) return 'learning';      // recalled at most once, or just lapsed
  if ((s.interval || 0) < 21) return 'young';    // sticking, but under 3 weeks
  return 'mature';                               // 21+ days between reviews — locked in
}

function greetingFor(date) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/* Mastery = the share of a deck that has reached "mature". Guards the empty
   deck, because 0/0 renders as NaN% and looks broken. */
function deckMastery(cards) {
  const list = Array.isArray(cards) ? cards : [];
  const total = list.length;
  if (total === 0) return { total: 0, mastered: 0, pct: 0 };
  const mastered = list.filter(c => cardStatus(c) === 'mature').length;
  return { total, mastered, pct: Math.round(mastered / total * 100) };
}

function estimateMinutes(dueCards) {
  const n = dueCards || 0;
  if (n <= 0) return 0;
  return Math.max(1, Math.ceil(n * SECONDS_PER_CARD / 60));
}

/* Cards you keep getting wrong. `lapses` already exists in newSrs() and
   increments on "Again", so this needed no data model change.

   Ties break on the front text so the order is identical between renders —
   a list that reshuffles itself every time you look at it reads as broken. */
function weakSpots(cards, decks, limit) {
  const list = Array.isArray(cards) ? cards : [];
  const deckList = Array.isArray(decks) ? decks : [];
  const nameById = {};
  deckList.forEach(d => { if (d && d.id) nameById[d.id] = d.name; });

  return list
    .filter(c => c && c.srs && (c.srs.lapses || 0) >= WEAK_MIN_LAPSES)
    .filter(c => nameById[c.deckId] !== undefined)   // deck deleted → skip, don't show blank
    .map(c => ({ id: c.id, front: c.front, deckName: nameById[c.deckId], lapses: c.srs.lapses }))
    .sort((a, b) => (b.lapses - a.lapses) || String(a.front).localeCompare(String(b.front)))
    .slice(0, limit === undefined ? WEAK_LIMIT : limit);
}

/* Reviews for each of the last `days` days, oldest first. Missing days are 0
   rather than absent, so the bar chart has no gaps to reason about. */
function reviewsPerDay(log, days, now) {
  const safe = (log && typeof log === 'object') ? log : {};
  const out = [];
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    const key = dayKey(cursor.getTime());
    out.push({ key, n: safe[key] || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/* ── 11E-impure ──────────────────────────────────────────────────
   Rendering below this line. */

/* ----------------------------------------------------------------
   12. TOAST + modal keyboard helpers + BOOT
   ---------------------------------------------------------------- */

/* The Blob + <a download> dance that every export in this app performs.
   Extracted when the audio manifest became its sixth caller; the five older
   export buttons still inline their own copy and could be moved onto this. */
function downloadFile(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

document.getElementById('deck-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); onCreateDeck(); }
  if (e.key === 'Escape') closeDeckModal();
});
document.getElementById('key-modal').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); onSaveKey(); }
  if (e.key === 'Escape') closeKeyModal();
});

/* ────────────────────────────────────────────────────────────────
   GLOBAL SEARCH (⌘K, feature #28) — impure half.

   The decisions all live in the pure block up in section 4A (globalSearch,
   searchRows, searchEmptyState), checked by "04 System/(C) test-search.mjs".
   Everything below is DOM: opening, painting, arrowing, navigating.
   ---------------------------------------------------------------- */

let searchOpen = false;
let searchActiveIndex = 0;
let searchRowsCache = [];
let searchReturnFocus = null;

// The pill claims a shortcut; on Windows/Linux the claim would be wrong. Cheap to
// get right, and a keyboard hint nobody can use is worse than none.
(function labelSearchShortcut() {
  const key = document.getElementById('search-pill-key');
  if (key && !/Mac|iPhone|iPad/.test(navigator.platform || '')) key.textContent = 'Ctrl K';
})();

function openSearch() {
  if (searchOpen) return;
  searchOpen = true;
  // Remember where focus was. Without this, closing the overlay drops a keyboard
  // user back at the top of the document and they lose their place completely.
  searchReturnFocus = document.activeElement;
  document.getElementById('search-overlay').hidden = false;
  const input = document.getElementById('search-input');
  input.value = '';
  input.focus();
  onSearchInput();
}

function closeSearch() {
  if (!searchOpen) return;
  searchOpen = false;
  document.getElementById('search-overlay').hidden = true;
  searchRowsCache = [];
  searchActiveIndex = 0;
  if (searchReturnFocus && document.contains(searchReturnFocus)) searchReturnFocus.focus();
  searchReturnFocus = null;
}

function onSearchInput() {
  const query = document.getElementById('search-input').value;
  const results = globalSearch(loadData(), query);
  searchRowsCache = searchRows(results);
  searchActiveIndex = 0;
  renderSearchResults(results, query);
}

/** Move the highlight, wrapping at both ends. */
function moveSearchActive(delta) {
  if (!searchRowsCache.length) return;
  const n = searchRowsCache.length;
  searchActiveIndex = ((searchActiveIndex + delta) % n + n) % n;
  paintSearchActive();
}

function paintSearchActive() {
  const rows = document.querySelectorAll('#search-results .search-row');
  rows.forEach((el, i) => {
    const on = i === searchActiveIndex;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    if (on) {
      el.scrollIntoView({ block: 'nearest' });
      // Tells a screen reader which option is current without moving real focus
      // out of the input, which would break typing.
      document.getElementById('search-input').setAttribute('aria-activedescendant', el.id);
    }
  });
}

const SEARCH_GROUP_LABELS = { deck: 'Decks', card: 'Cards', assignment: 'Assignments' };

function renderSearchResults(results, query) {
  const box = document.getElementById('search-results');
  const empty = searchEmptyState(query, results.total);
  if (empty.show) {
    box.innerHTML = `<div class="search-empty">${escapeHtml(empty.text)}</div>`;
    return;
  }

  // Walk the SAME flat list the keyboard uses, inserting a heading whenever the
  // type changes. Deriving both from one array is what keeps ↓↓↓ Enter honest.
  let html = '';
  let lastType = null;
  searchRowsCache.forEach((row, i) => {
    if (row.type !== lastType) {
      html += `<div class="search-group" role="presentation">${SEARCH_GROUP_LABELS[row.type] || ''}</div>`;
      lastType = row.type;
    }
    html += `<div class="search-row${i === searchActiveIndex ? ' active' : ''}" role="option"
                  id="search-row-${i}" aria-selected="${i === searchActiveIndex}"
                  onclick="activateSearchRow(${i})" onmousemove="setSearchActive(${i})">
      <span class="search-row-label">${escapeHtml(row.label)}</span>
      <span class="search-row-sub">${escapeHtml(row.sub)}</span>
    </div>`;
  });
  box.innerHTML = html;
  paintSearchActive();
}

function setSearchActive(i) {
  if (i === searchActiveIndex) return;      // avoid repainting on every mouse pixel
  searchActiveIndex = i;
  paintSearchActive();
}

/** Open whatever the row points at. Closes first so focus lands on the new screen. */
function activateSearchRow(i) {
  const row = searchRowsCache[i];
  if (!row) return;
  closeSearch();
  if (row.type === 'assignment') { goAssignments(); return; }
  // Deck and card both land on the deck. A card additionally gets highlighted, so
  // you can see WHICH card matched instead of hunting a long list yourself.
  goDeck(row.deckId);
  if (row.type === 'card') highlightCard(row.id);
}

/** Scroll a card row into view and flash it. Purely a way of saying "this one". */
function highlightCard(cardId) {
  const el = document.querySelector(`.card-row[data-card-id="${cardId}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('card-row-found');
  setTimeout(() => el.classList.remove('card-row-found'), 2000);
}

document.addEventListener('keydown', e => {
  // ⌘K on macOS, Ctrl+K elsewhere. Works from every screen because it is bound to
  // the document, not to any one section.
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    searchOpen ? closeSearch() : openSearch();
    return;
  }
  if (!searchOpen) return;
  if (e.key === 'Escape')    { e.preventDefault(); closeSearch(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchActive(1); return; }
  if (e.key === 'ArrowUp')   { e.preventDefault(); moveSearchActive(-1); return; }
  if (e.key === 'Enter')     { e.preventDefault(); activateSearchRow(searchActiveIndex); }
});

/* ── PWA — install + offline (feature #26) ────────────────────────
   The service worker can serve stale code indefinitely and report nothing, so the
   app asks which build is actually running and says so when it changes. */

const BUILD_ID_KEY = 'recall.lastBuildId';

/* ── PURE pwa. Sliced by "04 System/(C) test-pwa.mjs" — must stay free of DOM,
   network and localStorage. ── */

/**
 * Whether to tell Diogo the app updated, and which build id to store next.
 *
 * A fresh install must NOT say "Updated" — there is nothing to have updated from.
 * And the stored id has to advance whenever the notice fires, or it fires forever.
 */
function updateNotice(storedId, currentId) {
  if (!currentId)             return { show: false, text: '', store: storedId || null };
  if (!storedId)              return { show: false, text: '', store: currentId };
  if (storedId === currentId) return { show: false, text: '', store: currentId };
  return { show: true, text: 'Updated to the latest version', store: currentId };
}

/**
 * Is everything needed for offline actually cached, and if not, say how short it is.
 *
 * This exists because the failure it describes was INVISIBLE. A precache that fails
 * leaves the app looking perfectly healthy — it still opens, because the browser's own
 * HTTP cache holds the small files — and only the audio is missing. Nothing said so.
 *
 * Never claims ready on a partial cache, however close.
 */
function cacheStatus(cached, expected) {
  if (!expected)          return { ready: false, text: 'Offline: not measured yet' };
  if (cached >= expected) return { ready: true,  text: 'Offline: all ' + expected + ' files ready' };
  return { ready: false, text: 'Offline: only ' + cached + '/' + expected + ' files ready' };
}

/**
 * Whether to offer the "New version ready" button, given a waiting worker.
 *
 * This is the piece #26 was missing, and it is NOT the same question updateNotice()
 * answers. updateNotice() reports which build is running versus which one ran last
 * time — it can only speak AFTER the swap already happened. This one speaks BEFORE:
 * a new worker has downloaded and is stuck in "waiting", and nothing but an explicit
 * click will ever let it through.
 *
 * `isControlled` false means no worker is serving this page yet — a first install,
 * not an update. Same rule as updateNotice(): never announce an update to someone
 * who has never run an older build.
 *
 * It carries an ACTION, not just text. A notice with nothing to click is what the
 * app already had, and it left ⌘Q as the only way through.
 */
function updatePrompt(hasWaiting, isControlled) {
  if (!hasWaiting)   return { show: false, text: '', action: '' };
  if (!isControlled) return { show: false, text: '', action: '' };
  return { show: true, text: 'New version ready', action: 'Update' };
}

/* ── END PURE pwa ── */

let currentBuildId = null;
let expectedCacheEntries = 0;
let reloadingForUpdate = false;

/** Ask the worker which build it is, and how many files it expects to have cached. */
function askBuildId(worker) {
  return new Promise(resolve => {
    if (!worker) return resolve(null);
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 2000);
    channel.port1.onmessage = e => {
      clearTimeout(timer);
      if (e.data && e.data.expected) expectedCacheEntries = e.data.expected;
      resolve((e.data && e.data.buildId) || null);
    };
    worker.postMessage({ type: 'build-id' }, [channel.port2]);
  });
}

/** Count what is actually in this build's cache. Null when it cannot be determined. */
async function countCachedEntries() {
  if (!('caches' in window) || !currentBuildId) return null;
  try {
    const cache = await caches.open('recall-' + currentBuildId);
    return (await cache.keys()).length;
  } catch (e) {
    return null;
  }
}

/** The waiting worker we are offering to activate. Null when there is nothing to take. */
let pendingWorker = null;

/** Show or hide the update bar from a pure updatePrompt() decision. */
function renderUpdateBar(prompt) {
  const bar = document.getElementById('update-bar');
  if (!bar) return;
  bar.hidden = !prompt.show;
  if (!prompt.show) return;
  document.getElementById('update-bar-text').textContent = prompt.text;
  document.getElementById('update-bar-action').textContent = prompt.action;
}

function dismissUpdateBar() {
  const bar = document.getElementById('update-bar');
  if (bar) bar.hidden = true;
}

/**
 * Take the waiting build. Tells the worker to stop waiting; the reload happens in the
 * controllerchange listener below, once the new worker is actually in charge — not here,
 * because reloading first would just reload the OLD code.
 */
function onTakeUpdate() {
  if (!pendingWorker) return dismissUpdateBar();
  pendingWorker.postMessage({ type: 'skip-waiting' });
  document.getElementById('update-bar-action').textContent = 'Updating…';
}

/** Offer the update if this worker is genuinely waiting on a controlled page. */
function offerUpdate(worker) {
  if (!worker) return;
  pendingWorker = worker;
  renderUpdateBar(updatePrompt(true, !!navigator.serviceWorker.controller));
}

async function initServiceWorker() {
  // Registration needs a secure origin. On the file:// backup copy it simply does not
  // run, and everything else in the app works exactly as before.
  if (!('serviceWorker' in navigator)) return;

  // The swap is only real once the new worker controls the page, so the reload waits
  // for that event rather than for the click. The guard is not optional: Chrome can
  // fire controllerchange again after the reload, and the page would reload forever.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloadingForUpdate) return;
    reloadingForUpdate = true;
    location.reload();
  });

  try {
    await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;

    // Two separate ways an update appears, and #26 watched for neither.
    // 1. Already waiting — it finished installing during an earlier visit and has been
    //    stuck ever since, which is precisely the four-⌘Q case from 2026-08-01.
    if (reg.waiting) offerUpdate(reg.waiting);

    // 2. It installs while this page is open. updatefound fires, and the new worker
    //    reaches 'installed'. A controller already present means it went to waiting
    //    rather than straight to active, so there IS something to offer.
    reg.addEventListener('updatefound', () => {
      const incoming = reg.installing;
      if (!incoming) return;
      incoming.addEventListener('statechange', () => {
        if (incoming.state === 'installed' && navigator.serviceWorker.controller) {
          offerUpdate(incoming);
        }
      });
    });

    // reg.active is the worker actually SERVING this page. If an update is downloaded
    // but still waiting, that is deliberately the old one — reporting the waiting
    // build would claim an update that has not taken effect yet.
    currentBuildId = await askBuildId(reg.active);
    if (!currentBuildId) return;

    let stored = null;
    try { stored = localStorage.getItem(BUILD_ID_KEY); } catch (e) { /* private mode */ }

    const notice = updateNotice(stored, currentBuildId);
    try {
      if (notice.store) localStorage.setItem(BUILD_ID_KEY, notice.store);
    } catch (e) { /* storing the id is a nicety, never a reason to fail */ }

    if (notice.show) toast(notice.text);
  } catch (e) {
    // Offline study still works from whatever is already cached; a failed
    // registration must not take the app down with it.
    console.warn('Service worker did not register:', e);
  }
}

/* ── PURE assignments-view ───────────────────────────────────────
   13. ASSIGNMENTS — view (feature #27, checkpoint 2), pure half.

   Every string the Assignments UI renders is built here, by functions that take
   their arguments and touch nothing else — no DOM, no localStorage, no clock.
   The impure renderAssignments() below does nothing but assign innerHTML.

   Why the split: (C) test-assignments-ui.mjs slices this block and asserts the
   markup directly. Build markup inside a render function and it becomes invisible
   to the suite — which is how 372 green checks once sat on top of a header
   rendering `Label | % | %`. Check W6 fails if renderAssignments grows a template
   literal of its own.

   This block MAY reference `escapeHtml`, `uniqueTags` and the PURE assignments
   block above (startOfDay, isOverdue, sortAssignments, filterAssignments) — the
   suite slices all of them out of this same file rather than stubbing them, so
   the suite cannot drift from the app. It may reference nothing else.
   ---------------------------------------------------------------- */

const ASG_HOME_MAX = 3;
const PRIORITY_LABEL = { high: 'High', med: 'Medium', low: 'Low' };

/* A <input type="date"> value, or '' for no due date. */
function tsToDateInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const two = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

/* The inverse, and the one place a timezone bug would hide.

   `new Date('2026-07-31')` parses as UTC midnight. In Lisbon that lands on the right
   calendar day BY LUCK, so a round-trip test passes with the bug present and a due
   date silently shifts by a day for anyone further west. Built from parts instead,
   which is local by construction. Pinned by check T10. */
function dateInputToTs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str == null ? '' : str).trim());
  if (!m) return 0;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  const d = new Date(y, mo - 1, da, 0, 0, 0, 0);
  // Date rolls 2026-02-31 over into March rather than refusing it. A due date the
  // user did not choose is worse than no due date.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) return 0;
  return d.getTime();
}

function shortDate(ts) {
  // Explicit locale, matching describeBackup. renderDashboard passes undefined and is
  // therefore untestable on this point; a check asserting "7 Aug" under an implicit
  // locale would pass on this machine and fail on another.
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDueDate(ts, now) {
  if (!ts) return '';
  const day = startOfDay(ts);
  const today = startOfDay(now);
  if (day < today) return 'Overdue · ' + shortDate(ts);
  if (day === today) return 'Today';
  const t = new Date(today);
  t.setDate(t.getDate() + 1);           // via Date, so a DST boundary cannot skew it
  if (day === t.getTime()) return 'Tomorrow';
  return shortDate(ts);
}

/* Subjects reuse uniqueTags outright: same dedupe, same case-folding, same sort as
   deck tags, so the two vocabularies can never order differently on screen. */
function assignmentSubjects(list) {
  return uniqueTags((list || []).map(a => ({ tag: a.subject })));
}

/* The datalist merges deck tags AND subjects already typed, so a subject with no deck
   yet still suggests itself — the "log a Filosofia test before creating a Filosofia
   deck" case the free-text decision was made for. */
function subjectOptionsHtml(decks, list) {
  const merged = uniqueTags([
    ...(decks || []).map(d => ({ tag: d.tag })),
    ...(list || []).map(a => ({ tag: a.subject }))
  ]);
  return merged.map(s => `<option value="${escapeHtml(s)}"></option>`).join('');
}

function subjectChipsHtml(subjects, active) {
  const isAll = !active;
  const chips = (subjects || []).map((s, i) =>
    `<button class="tag-chip${active === s ? ' active' : ''}" aria-pressed="${active === s}" ` +
    `onclick="onAsgSubjectChip(${i})">${escapeHtml(s)}</button>`);
  return `<button class="tag-chip${isAll ? ' active' : ''}" aria-pressed="${isAll}" ` +
         `onclick="onAsgSubjectChip(-1)">All</button>` + chips.join('');
}

/* Absent entirely when nothing is completed: a toggle for an empty set is noise, and
   every element here has to earn its place. */
function completedToggleHtml(doneCount, showCompleted) {
  if (!doneCount) return '';
  return `<button class="tag-chip${showCompleted ? ' active' : ''}" aria-pressed="${!!showCompleted}" ` +
         `onclick="onAsgToggleCompleted()">${showCompleted ? 'Hide' : 'Show'} completed (${doneCount})</button>`;
}

/* Handlers take the RENDER INDEX, never the id. onTagChip documents why: a title is
   user text, and the browser decodes entities in attributes before the JS runs, so
   escaping does not protect an inlined value. Pinned by check X28. */
function assignmentRowHtml(a, index, ctx) {
  const overdue = isOverdue(a, ctx.now);
  const due = formatDueDate(a.dueAt, ctx.now);
  const deck = (ctx.decks || []).find(d => d.id === a.deckId);
  const name = escapeHtml(a.title || 'Untitled');
  const meta = [
    a.subject ? `<span class="asg-subject">${escapeHtml(a.subject)}</span>` : '',
    `<span class="asg-prio">${PRIORITY_LABEL[a.priority] || PRIORITY_LABEL.med}</span>`,
    due ? `<span class="asg-due">${escapeHtml(due)}</span>` : '',
    // A dangling deckId renders nothing rather than a blank chip — the weakSpots
    // precedent: skip what you cannot name.
    deck ? `<span class="asg-deck-chip">${escapeHtml(deck.name)}</span>` : ''
  ].join('');

  return `<div class="asg-row${overdue ? ' overdue' : ''}${a.done ? ' asg-done' : ''}">` +
    `<button class="asg-check" aria-label="Mark ${name} as ${a.done ? 'not done' : 'done'}" ` +
      `onclick="onToggleAssignment(${index})">${a.done ? '✓' : ''}</button>` +
    `<div class="asg-main"><div class="asg-title">${name}</div>` +
      `<div class="asg-meta">${meta}</div></div>` +
    `<button class="icon-btn" aria-label="Edit ${name}" onclick="openAssignmentModal(${index})">✎</button>` +
    `<button class="icon-btn" aria-label="Delete ${name}" onclick="onDeleteAssignment(${index})">✕</button>` +
  `</div>`;
}

/* The whole filter row, wrapped in the SAME .tag-row the decks screen uses
   (display:flex, gap:6px, flex-wrap:wrap). Returning bare buttons into a container
   with no styling of its own left every chip touching its neighbour — "All" glued to
   "Biologia" — while the decks screen looked correct, because that one has the
   wrapper. Reusing the class rather than adding a second one keeps the two chip rows
   from drifting apart. Pinned by check L42. */
function assignmentControlsHtml(subjects, active, doneCount, showCompleted) {
  return `<div class="tag-row">` +
    subjectChipsHtml(subjects, active) +
    completedToggleHtml(doneCount, showCompleted) +
  `</div>`;
}

/* Two different empty states on purpose. Telling someone who has five assignments to
   "create your first" is a lie, and it hides the fact that a filter is on. */
function assignmentListHtml(shown, ctx) {
  const list = shown || [];
  if (list.length === 0) {
    if (!ctx.total) {
      return `<div class="empty">` +
        `<div class="empty-title">No assignments yet</div>` +
        `<div class="empty-sub">Track homework, tests and essays next to the decks you study for them.</div>` +
        `<div class="empty-actions">` +
          `<button class="btn btn-primary" onclick="openAssignmentModal(-1)">+ New assignment</button>` +
        `</div></div>`;
    }
    return `<p class="filter-empty">Nothing matches this filter.</p>`;
  }
  return list.map((a, i) => assignmentRowHtml(a, i, ctx)).join('');
}

/* Returns '' — not an empty box — when nothing is open. The design note is explicit,
   and an empty panel on the Home screen is worse than no panel. */
function assignmentPanelHtml(list, ctx) {
  const open = filterAssignments(list, {});
  if (open.length === 0) return '';
  const next = sortAssignments(open, 'due').slice(0, ASG_HOME_MAX);
  const rows = next.map(a =>
    `<div class="asg-panel-row${isOverdue(a, ctx.now) ? ' overdue' : ''}">` +
      `<span class="asg-panel-title">${escapeHtml(a.title || 'Untitled')}</span>` +
      `<span class="asg-panel-prio">${PRIORITY_LABEL[a.priority] || PRIORITY_LABEL.med}</span>` +
      `<span class="asg-panel-due">${escapeHtml(formatDueDate(a.dueAt, ctx.now))}</span>` +
    `</div>`).join('');
  return `<div class="asg-panel-head"><h2>Assignments</h2>` +
    `<button class="btn btn-outline" onclick="goAssignments()">See all</button></div>${rows}`;
}
/* ── END PURE assignments-view */

/* ── 13-impure ───────────────────────────────────────────────────
   The thin shell. Every function here reads state, calls a pure builder, and
   assigns the result. No markup is built in this block — check W6 fails if
   renderAssignments grows a template literal, because markup written here would
   be invisible to (C) test-assignments-ui.mjs.

   Transient view state, mirroring activeTag/renderedTags on the decks screen:
   never persisted, so a refresh starts unfiltered. */

let asgSort = 'due';
let asgSubject = null;          // selected subject chip, or null = All
let asgShowCompleted = false;
let renderedSubjects = [];      // subjects as last rendered; chips click by index
let renderedAssignments = [];   // rows as last rendered; handlers dispatch by index
let editingAssignmentId = null;

function goAssignments() {
  setCrumb('');
  setActiveTab('assignments');
  renderAssignments();
  showScreen('assignments');
}

function renderAssignments() {
  const data = loadData();
  const all = data.assignments;
  const doneCount = all.filter(a => a.done).length;

  renderedSubjects = assignmentSubjects(asgShowCompleted ? all : all.filter(a => !a.done));
  // A chip for a subject that no longer exists would filter to nothing forever.
  if (asgSubject && !renderedSubjects.some(s => s === asgSubject)) asgSubject = null;

  const shown = sortAssignments(
    filterAssignments(all, { subject: asgSubject, showCompleted: asgShowCompleted }),
    asgSort);
  // Assigned BEFORE the markup is built, so the indices the handlers receive
  // always match the rows the user is looking at.
  renderedAssignments = shown;

  const ctx = { now: Date.now(), decks: data.decks, total: all.length };
  document.getElementById('asg-controls').innerHTML =
    assignmentControlsHtml(renderedSubjects, asgSubject, doneCount, asgShowCompleted);
  document.getElementById('assignments-body').innerHTML = assignmentListHtml(shown, ctx);
  // Rendered here rather than only on screen entry, so adding a client ID in Settings
  // and coming back shows "Not connected" instead of the stale "Not set up".
  renderGCalPanel();
}

/* The Home panel. Hidden entirely — not an empty box — when nothing is open. */
function renderAssignmentsPanel(data) {
  const el = document.getElementById('dash-assignments');
  if (!el) return;
  const html = assignmentPanelHtml(data.assignments, { now: Date.now(), decks: data.decks });
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

function onAsgSortChange() {
  asgSort = document.getElementById('asg-sort').value;
  renderAssignments();
}

function onAsgSubjectChip(index) {
  if (index === -1) asgSubject = null;
  else asgSubject = (asgSubject === renderedSubjects[index]) ? null : renderedSubjects[index];
  renderAssignments();
}

function onAsgToggleCompleted() {
  asgShowCompleted = !asgShowCompleted;
  renderAssignments();
}

/* index -1 = create. Anything else edits the row at that render index. */
function openAssignmentModal(index) {
  const data = loadData();
  const editing = index >= 0 ? renderedAssignments[index] : null;
  editingAssignmentId = editing ? editing.id : null;

  document.getElementById('asg-modal-title').textContent =
    editing ? 'Edit assignment' : 'New assignment';
  document.getElementById('asg-save-btn').textContent =
    editing ? 'Save changes' : 'Create assignment';
  document.getElementById('asg-title').value = editing ? editing.title : '';
  document.getElementById('asg-subject').value = editing ? editing.subject : '';
  document.getElementById('asg-due').value = editing ? tsToDateInput(editing.dueAt) : '';
  document.getElementById('asg-priority').value = editing ? editing.priority : 'med';
  document.getElementById('asg-error').textContent = '';

  document.getElementById('asg-subjects').innerHTML =
    subjectOptionsHtml(data.decks, data.assignments);
  document.getElementById('asg-deck').innerHTML =
    '<option value="">None</option>' +
    data.decks.map(d => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('');
  document.getElementById('asg-deck').value = editing ? editing.deckId : '';

  document.getElementById('assignment-modal').classList.add('open');
  document.getElementById('asg-title').focus();
}

function closeAssignmentModal() {
  document.getElementById('assignment-modal').classList.remove('open');
  editingAssignmentId = null;
}

function onSaveAssignment() {
  const fields = {
    title: document.getElementById('asg-title').value,
    subject: document.getElementById('asg-subject').value,
    dueAt: dateInputToTs(document.getElementById('asg-due').value),
    priority: document.getElementById('asg-priority').value,
    deckId: document.getElementById('asg-deck').value
  };
  if (!fields.title.trim()) {
    document.getElementById('asg-error').textContent = 'Give the assignment a title.';
    return;
  }
  if (editingAssignmentId) updateAssignment(editingAssignmentId, fields);
  else createAssignment(fields);
  closeAssignmentModal();
  renderAssignments();
}

/* Marking done is reversible and never destroys the record, so it asks nothing.
   Deleting does. */
function onToggleAssignment(index) {
  const a = renderedAssignments[index];
  if (!a) return;
  toggleAssignmentDone(a.id);
  renderAssignments();
}

function onDeleteAssignment(index) {
  const a = renderedAssignments[index];
  if (!a) return;
  if (!confirm(`Delete "${a.title}"? This cannot be undone.`)) return;
  deleteAssignment(a.id);
  renderAssignments();
}

goHome();
initServiceWorker();

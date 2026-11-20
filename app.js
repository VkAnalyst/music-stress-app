/* =============================================================================
   Stress & Recovery Session Runner, app.js
   -----------------------------------------------------------------------------
   Front-end only. The session lives in the in-memory `S` record (cleared on New
   session / Log out). At the end, DataSink posts the STAI-6 rows and a session
   summary to the Google Sheet configured in config.js (saving.url).

   Contents
     1.  Setup and helpers
     2.  Icons
     3.  Session clock (pausable, monotonic) and session-time timers
     4.  Ticker (keeps time advancing even when the tab is throttled)
     5.  Session record and DataSink (the place to add saving later)
     6.  Screen stage, chrome bar, shared UI components
     7.  Music controller (YouTube IFrame API or local audio file)
     8.  Runner (the timeline engine)
     9.  Step factories: rest, STAI-6, instruction card, tasks, final question
     10. Session start / pause / end
     11. Screens: login, setup, end
     12. Global keyboard, fullscreen, idle cursor, boot

   Timing model
     All phase timing uses one session clock built on performance.now(), which
     freezes while paused. Each phase has an exact end time on that clock. When a
     phase ends, the next phase starts at the previous phase's scheduled end time,
     not at "whenever the tick happened", so the timeline never drifts and a late
     tick (slow or background tab) is caught up correctly.
   ============================================================================= */
(() => {
  'use strict';

  /* =========================================================================
     1. SETUP AND HELPERS
     ========================================================================= */
  const CFG = window.APP_CONFIG;
  if (!CFG) { document.body.textContent = 'config.js could not be loaded.'; return; }

  const T = CFG.timing;
  const SPEED = Math.max(0.01, Number(CFG.testSpeed) || 1);
  /** Phase duration in ms on the session clock (testSpeed shortens phases). */
  const dur = (sec) => ((Number(sec) || 0) * 1000) / SPEED;
  const TASK_IDS = Object.keys(CFG.tasks);

  const $ = (sel, root = document) => root.querySelector(sel);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /** Small element builder: h('div', {class:'x', onClick: fn}, child, ...) */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Remaining ms -> "m:ss" (rounded up, so 0:00 only at the very end). */
  function fmtClock(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000 - 1e-6));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtLength(sec) {
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    if (!m) return `${s} s`;
    return s ? `${m} min ${s} s` : `${m} min`;
  }
  const fmtTime = (d) => d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '–';
  const fmtNum = (v, digits = 1) => (v == null || !isFinite(v)) ? null : v.toFixed(digits);

  /** Replace {start} / {step} style placeholders in rule text with task values. */
  const fill = (text, obj) => String(text).replace(/\{(\w+)\}/g, (m, k) => (obj[k] != null ? obj[k] : m));

  /** Values available as {placeholders} in task rule text. */
  const ruleValues = (task) => Object.assign({
    taskSeconds: CFG.timing.taskSeconds,
    explainSeconds: task.readSeconds != null ? CFG.timing.taskSeconds - task.readSeconds : null,
  }, task);

  /** Restart a one-shot CSS animation class. */
  function bump(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

  /* =========================================================================
     2. ICONS (inline SVG, stroke style)
     ========================================================================= */
  const svg = (paths, cls = 'icon') =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    calculator: svg('<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M8 6.5h8"/><path d="M8 11h.01M12 11h.01M16 11h.01M8 14.5h.01M12 14.5h.01M8 18h.01M12 18h.01"/><path d="M16 14.5V18"/>'),
    pulse: svg('<path d="M2 12h4l3-8 6 16 3-8h4"/>'),
    palette: svg('<path d="M12 2.5a9.5 9.5 0 1 0 0 19c1 0 1.6-.8 1.6-1.6 0-.5-.2-.8-.4-1.1-.3-.3-.4-.6-.4-1.1 0-.9.7-1.6 1.6-1.6h1.9a5.2 5.2 0 0 0 5.2-5.2C21.5 6.3 17.2 2.5 12 2.5Z"/><circle cx="7.5" cy="11.5" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/>'),
    speech: svg('<path d="M21 14.5a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/><path d="M8 9h8M8 12.5h5"/>'),
    book: svg('<path d="M2.5 4h6a3.5 3.5 0 0 1 3.5 3.5V21a2.6 2.6 0 0 0-2.6-2.6H2.5Z"/><path d="M21.5 4h-6A3.5 3.5 0 0 0 12 7.5V21a2.6 2.6 0 0 1 2.6-2.6h6.9Z"/>'),
    leaf: svg('<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/><path d="M2 21c0-3 1.9-5.4 5.1-6 2.4-.5 4.9-2 5.9-3"/>'),
    music: svg('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
    clipboard: svg('<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>'),
    flag: svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1Z"/><path d="M4 22v-7"/>'),
    pause: svg('<rect x="6" y="4.5" width="4" height="15" rx="1.2"/><rect x="14" y="4.5" width="4" height="15" rx="1.2"/>'),
    play: svg('<path d="M7 4.5v15l12-7.5Z"/>'),
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    lock: svg('<rect x="4" y="11" width="16" height="10" rx="2.2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    alert: svg('<path d="M12 3 2 20h20Z"/><path d="M12 9.5v4.5M12 17h.01"/>'),
    shield: svg('<path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6Z"/><path d="m9 12 2 2 4-4"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
    refresh: svg('<path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/>'),
    volume: svg('<path d="M11 5 6 9H3v6h3l5 4Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/>'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    skip: svg('<path d="M5 4.5v15l10-7.5Z"/><path d="M19 5v14"/>'),
  };

  /* =========================================================================
     3. SESSION CLOCK AND SESSION-TIME TIMERS
     ========================================================================= */
  /** Monotonic session clock in ms. Frozen while paused, so pausing never
      loses or skips time. */
  const Clock = {
    origin: 0, pausedAt: 0, pausedTotal: 0, paused: false, started: false,
    start() { this.origin = performance.now(); this.pausedTotal = 0; this.paused = false; this.started = true; },
    stop() { this.started = false; this.paused = false; },
    now() {
      if (!this.started) return 0;
      const t = this.paused ? this.pausedAt : performance.now();
      return t - this.origin - this.pausedTotal;
    },
    pause() { if (!this.paused) { this.pausedAt = performance.now(); this.paused = true; } },
    resume() { if (this.paused) { this.pausedTotal += performance.now() - this.pausedAt; this.paused = false; } },
  };

  /** Timers that run on the session clock (so they pause too). They belong to
      the current phase and are all cleared when the phase changes. */
  const Timers = {
    list: [], seq: 0,
    at(time, fn) { const id = ++this.seq; this.list.push({ id, at: time, fn }); return id; },
    after(ms, fn) { return this.at(Clock.now() + ms, fn); },
    cancel(id) { this.list = this.list.filter((t) => t.id !== id); },
    clear() { this.list = []; },
    /** Run every timer due at or before `limit`, earliest first. Each callback
        receives its scheduled time so chains stay exact even if ticks are late. */
    run(limit) {
      for (;;) {
        let best = null;
        for (const t of this.list) if (t.at <= limit && (!best || t.at < best.at)) best = t;
        if (!best) return;
        this.list.splice(this.list.indexOf(best), 1);
        try { best.fn(best.at); } catch (e) { console.error(e); }
      }
    },
  };

  /* =========================================================================
     4. TICKER
     A 50 ms interval drives the runner, plus a Web Worker heartbeat which
     browsers throttle far less than main-thread timers in background tabs.
     Timing accuracy comes from the clock, not from tick regularity.
     ========================================================================= */
  const Ticker = {
    iv: null, worker: null,
    start() {
      if (this.iv) return;
      this.iv = setInterval(() => Runner.tick(), 50);
      try {
        const src = 'setInterval(function(){postMessage(0)},100);';
        const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        this.worker = new Worker(url);
        this.worker.onmessage = () => Runner.tick();
      } catch (e) { this.worker = null; }
    },
    stop() {
      clearInterval(this.iv); this.iv = null;
      if (this.worker) { this.worker.terminate(); this.worker = null; }
    },
  };

  /* =========================================================================
     5. SESSION RECORD AND DATA SINK
     ========================================================================= */
  /** The in-memory record for one session. Shaped so it can be serialised
      as-is (JSON) if saving is added later. */
  let S = null;
  let running = false;

  function newSessionRecord(condition, week) {
    return {
      id: `S-${Date.now().toString(36).toUpperCase()}`,
      condition,                 // 'music' | 'quiet'
      week: week || '',          // e.g. 'Week 0 (baseline)'
      testSpeed: SPEED,
      startedAt: null, endedAt: null, aborted: false,
      taskOrder: [],             // e.g. ['C','A','D','B','E']
      stai: [null, null, null],  // see makeStaiStep
      tasks: {},                 // keyed by task id, see makeTaskStep
      mostStressful: null,       // task id or null
      music: null,               // what actually happened with music
      events: [],                // phase starts, pauses, resumes (timeline)
    };
  }

  function logEvent(type, label, atSessionMs) {
    if (!S) return;
    const now = Clock.now();
    const at = atSessionMs == null ? now : atSessionMs;
    // wall clock of the event itself (corrects for a late tick)
    S.events.push({ type, label, sessionMs: Math.round(at), wall: new Date(Date.now() - Math.max(0, now - at)) });
  }

  /** Saves a finished session to Google Sheets through the Apps Script web app.
      Rows are queued in localStorage first, then posted one by one, so a dropped
      connection or closed tab does not lose them: leftovers are retried the next
      time the page loads. (The request is "no-cors", so the browser cannot read
      the reply: "sent" means the request was delivered, check the sheet once.) */
  const DataSink = {
    QUEUE_KEY: 'stressSession.pendingRows',
    listener: null,
    enabled() { return !!(CFG.saving && CFG.saving.enabled && CFG.saving.url); },
    notify() { if (this.listener) this.listener(); },

    readQueue() { try { return JSON.parse(localStorage.getItem(this.QUEUE_KEY) || '[]'); } catch (e) { return []; } },
    writeQueue(q) { try { localStorage.setItem(this.QUEUE_KEY, JSON.stringify(q)); } catch (e) { /* storage unavailable */ } },

    /** Build the rows for one finished session. Column names match the sheet:
        Session_Summary : one row per session
        STAI_Responses  : one row per STAI-6 reached (up to 3)
        Task_Log        : one row per rest phase / task reached */
    rows(rec) {
      const labels = CFG.groupLabels || {};
      const group = rec.condition === 'music' ? (labels.music || 'Music') : (labels.quiet || 'Quiet rest');
      const stamp = new Date().toLocaleString('sv-SE');           // 2026-11-20 14:03:05 (local time)
      const num = (v) => (v == null || !isFinite(v) ? '' : Math.round(v * 100) / 100);
      const id = [stamp, rec.participantId || '', group, rec.week || ''];
      const timepoints = ['Baseline', 'Post-stress', 'Post-recovery'];
      const items = CFG.stai.items;

      const respHeaders = ['Timestamp', 'Participant_ID', 'Group', 'Session', 'Timepoint',
        'Q1_calm', 'Q2_tense', 'Q3_upset', 'Q4_relaxed', 'Q5_content', 'Q6_worried',
        'Sum_reverse_scored', 'STAI_Total'];
      const responses = rec.stai.filter((r) => r && r.reached).map((r) => ({
        type: 'response', headers: respHeaders,
        values: [...id, timepoints[r.n - 1] || `STAI${r.n}`,
          ...items.map((_, i) => (r.answers[i] == null ? '' : r.answers[i])),
          r.complete ? num(r.total / CFG.stai.scaleFactor) : '', r.complete ? num(r.total) : ''],
      }));

      const t = rec.stai.map((r) => (r && r.complete ? r.total : null));
      const react = t[0] != null && t[1] != null ? t[1] - t[0] : null;
      const recov = t[1] != null && t[2] != null ? t[1] - t[2] : null;
      const pct = react != null && recov != null && react !== 0 ? (recov / react) * 100 : null;
      const summary = {
        type: 'summary',
        headers: ['Timestamp', 'Participant_ID', 'Group', 'Session', 'STAI1_Total', 'STAI2_Total', 'STAI3_Total',
          'Reactivity_STAI2_minus_STAI1', 'Recovery_Score_STAI2_minus_STAI3', 'Recovery_Percent'],
        values: [...id, num(t[0]), num(t[1]), num(t[2]), num(react), num(recov), num(pct)],
      };

      const out = CFG.saving.summary === true ? [...responses, summary] : responses;   // STAI rows only by default
      if (CFG.saving.taskLog !== true) return out;

      const taskHeaders = ['Timestamp', 'Participant_ID', 'Group', 'Session', 'Phase', 'Position', 'Task_ID', 'Task',
        'Status', 'Time_Spent_s', 'Correct', 'Wrong', 'Missed', 'Accuracy_Percent', 'Avg_Response_Time_ms',
        'Last_Correct_Number', 'Passage'];
      const secs = (ms) => (ms == null ? '' : Math.round(ms / 100) / 10);
      const status = (r, fullMs) => (r.skipped ? 'Skipped' : (r.timeSpentMs != null && r.timeSpentMs < fullMs - 250 ? 'Ended early' : 'Completed'));
      const restRow = (key, label, fullSec) => {
        const r = rec.rest && rec.rest[key];
        if (!r || !r.reached) return null;
        return { type: 'task', headers: taskHeaders,
          values: [...id, label, '', '', label, status(r, dur(fullSec)), secs(r.timeSpentMs), '', '', '', '', '', '', ''] };
      };
      const taskRows = rec.taskOrder.map((tid, i) => {
        const r = rec.tasks[tid], cfg = CFG.tasks[tid];
        if (!r || !r.reached) return null;
        const serial = cfg.kind === 'serial', stroop = cfg.kind === 'stroop';
        const attempts = serial ? r.correct + r.wrong : stroop ? r.correct + r.wrong + r.missed : null;
        const rts = stroop ? (r.trials || []).filter((x) => typeof x.rt === 'number').map((x) => x.rt) : [];
        return { type: 'task', headers: taskHeaders,
          values: [...id, 'Task', i + 1, tid, cfg.label, status(r, dur(T.taskSeconds)), secs(r.timeSpentMs),
            serial || stroop ? r.correct : '', serial || stroop ? r.wrong : '', stroop ? r.missed : '',
            attempts ? num((r.correct / attempts) * 100) : '',
            rts.length ? Math.round(rts.reduce((x, y) => x + y, 0) / rts.length) : '',
            serial && r.lastCorrect != null ? r.lastCorrect : '', cfg.kind === 'reading' ? r.passage : ''] };
      });
      return [...out, restRow('baseline', 'Baseline rest', T.baselineSeconds), ...taskRows,
        restRow('recovery', 'Recovery', T.recoverySeconds)].filter(Boolean);
    },

    async post(payload) {
      await fetch(CFG.saving.url, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // plain text avoids a CORS preflight
        body: JSON.stringify(payload),
      });
    },

    /** Post everything in the queue, in order; stops at the first failure. */
    async flush() {
      if (!this.enabled()) return true;
      for (let tries = 0; tries < 3; tries++) {
        let q = this.readQueue();
        while (q.length) {
          try { await this.post(q[0]); } catch (e) { break; }
          q = this.readQueue().slice(1);
          this.writeQueue(q);
        }
        if (!q.length) return true;
        await new Promise((r) => setTimeout(r, 1500));
      }
      return false;
    },

    async save(rec) {
      if (!this.enabled()) { rec.save = { state: 'off' }; return; }
      if (rec.testSpeed !== 1) { rec.save = { state: 'test' }; return; }
      rec.save = { state: 'sending' };
      this.writeQueue(this.readQueue().concat(this.rows(rec)));
      this.notify();
      let ok = false;
      try { ok = await this.flush(); } catch (e) { console.error(e); }
      rec.save = { state: ok ? 'sent' : 'failed' };
      this.notify();
    },
  };

  /* =========================================================================
     6. STAGE, CHROME BAR, SHARED UI COMPONENTS
     ========================================================================= */
  const stage = $('#stage');
  const overlayRoot = $('#overlay-root');

  /** Cross-fade to a new screen element. */
  function showScreen(el) {
    for (const old of [...stage.children]) {
      if (old.classList.contains('is-leaving')) continue;
      old.classList.add('is-leaving');
      old.inert = true;
      setTimeout(() => old.remove(), 420);
    }
    stage.append(el);
    return el;
  }

  /** Set the accent colour that tints the background glow. */
  function setPhaseAccent(color) {
    document.body.style.setProperty('--phase', color || 'var(--accent)');
  }

  const Chrome = {
    label: $('#chrome-label'),
    fill: $('#chrome-progress-fill'),
    show() { document.body.classList.add('in-session'); },
    hide() { document.body.classList.remove('in-session'); },
    set(text) { this.label.textContent = text; },
    progress(f) { this.fill.style.transform = `scaleX(${clamp(f, 0, 1)})`; },
  };

  /** Circular countdown. size: xl | lg | md | sm. seconds: show "12" not "0:12". */
  function Ring({ size = 'md', caption = '', seconds = false } = {}) {
    const R = 46, C = 2 * Math.PI * R;
    const el = h('div', { class: `ring ring-${size}`, role: 'timer' });
    el.innerHTML =
      `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-track" cx="50" cy="50" r="${R}"/>` +
      `<circle class="ring-fill" cx="50" cy="50" r="${R}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="0"/></svg>` +
      `<div class="ring-center"><div class="ring-digits">–</div>${caption ? `<div class="ring-caption">${caption}</div>` : ''}</div>`;
    const fillEl = el.querySelector('.ring-fill');
    const digits = el.querySelector('.ring-digits');
    let last = '';
    return {
      el,
      set(remaining, total) {
        const f = total > 0 ? clamp(remaining / total, 0, 1) : 0;
        fillEl.style.strokeDashoffset = (C * (1 - f)).toFixed(2);
        const txt = seconds ? String(Math.max(0, Math.ceil(remaining / 1000 - 1e-6))) : fmtClock(remaining);
        if (txt !== last) { digits.textContent = txt; last = txt; el.setAttribute('aria-label', `${txt} remaining`); }
      },
    };
  }

  /** Header used by every task screen: chip on the left, timer on the right. */
  function taskHeader(task, pos, count, ring) {
    return h('header', { class: 'task-head' },
      h('div', { class: 'task-chip', html: `${ICON[task.icon] || ''}<span>${task.label}</span>` }),
      h('div', { class: 'task-pos' }, `Task ${pos} of ${count}`),
      h('div', { class: 'task-timer' }, ring.el));
  }

  /** "Skip" button for instruction cards and tasks: ends the step right now.
      Call it at the end of a step's enter(), after showScreen(). */
  function addSkip(step, label, onSkip) {
    if (!CFG.allowSkip) return;
    const screen = stage.lastElementChild;
    if (!screen) return;
    screen.append(h('button', {
      class: 'btn btn-ghost btn-sm skip-btn', type: 'button', tabindex: '-1',
      html: `${ICON.skip}<span>${label}</span>`,
      onClick: () => {
        if (!Runner.isLive(step)) return;
        if (onSkip) onSkip();
        logEvent('skip', `Skipped: ${step.name}`);
        Runner.next();
      },
    }));
  }

  /** Generic confirm dialog. Resolves true / false. */
  let dialogOpen = null;
  function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const close = (val) => { wrap.classList.add('is-leaving'); setTimeout(() => wrap.remove(), 250); dialogOpen = null; resolve(val); };
      const cancelBtn = h('button', { class: 'btn btn-ghost', onClick: () => close(false) }, cancelText);
      const okBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onClick: () => close(true) }, confirmText);
      const wrap = h('div', { class: 'overlay overlay-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'dlg-title' },
        h('div', { class: 'dialog' },
          h('h2', { id: 'dlg-title' }, title),
          body ? h('p', { class: 'muted' }, body) : null,
          h('div', { class: 'dialog-actions' }, cancelBtn, okBtn)));
      overlayRoot.append(wrap);
      dialogOpen = { close };
      cancelBtn.focus();
    });
  }

  /* =========================================================================
     7. MUSIC CONTROLLER
     Prepares the player at setup / session start, autoplays at the start of
     recovery, fades out to end exactly at the recovery end, pauses with Esc,
     and shows a "Tap to start the music" fallback if the browser blocks it.
     ========================================================================= */
  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); resolve(window.YT); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => { ytApiPromise = null; reject(new Error('The YouTube player could not be loaded (offline?)')); };
      document.head.append(s);
      setTimeout(() => reject(new Error('The YouTube player took too long to load')), 15000);
    });
    return ytApiPromise;
  }

  const Music = {
    mode: null,          // 'youtube' | 'file' | null
    ready: false,
    error: '',
    note: '',            // e.g. "YouTube unavailable, using the audio file"
    player: null, iframe: null, audio: null,
    active: false,       // true during the recovery phase
    testing: false,      // true while the researcher previews audio on setup
    startedOnce: false,
    lastVol: -1,
    ui: {},              // callbacks set by the recovery screen: onBlocked, onPlaying, onError
    statusListener: null,
    dock: $('#yt-dock'),

    yt() { return (CFG.music.youtubeVideoId || '').trim(); },
    file() { return (CFG.music.audioFile || '').trim(); },
    startOffset() { return Math.max(0, Number(CFG.music.youtubeStartSeconds) || 0); },

    /** Which source to use, following config.prefer. */
    pick(exclude) {
      const yt = this.yt() && exclude !== 'youtube', f = this.file() && exclude !== 'file';
      if (CFG.music.prefer === 'file') return f ? 'file' : yt ? 'youtube' : null;
      return yt ? 'youtube' : f ? 'file' : null;
    },

    status() {
      if (!this.mode) return { state: this.error ? 'error' : 'none', text: this.error || 'No music source is set in config.js' };
      const src = this.mode === 'youtube' ? `YouTube video ${this.yt()}` : this.file();
      if (this.error) return { state: 'error', text: `${src}: ${this.error}` };
      const note = this.note ? ` · ${this.note}` : '';
      return this.ready ? { state: 'ready', text: `${src} · ready${note}` } : { state: 'loading', text: `${src} · loading…${note}` };
    },
    emitStatus() { if (this.statusListener) this.statusListener(this.status()); },

    /** Load and cue the player so it is ready before recovery. */
    prepare() {
      const want = this.pick();
      if (want && want === this.mode && (this.player || this.iframe || this.audio)) { this.emitStatus(); return; }
      this.destroy();
      this.error = '';
      this.note = '';
      this.mode = want;
      if (want === 'youtube') this.prepYouTube();
      else if (want === 'file') this.prepFile();
      this.emitStatus();
    },

    /** Switch to the other source if the preferred one fails. */
    fail(msg) {
      const other = this.pick(this.mode);
      const failed = this.mode;
      console.warn('[music]', msg);
      if (other && other !== failed) {
        this.destroy();
        this.mode = other;
        this.error = '';
        this.note = `${failed === 'youtube' ? 'YouTube' : 'Audio file'} unavailable (${msg}), using the other source`;
        if (other === 'youtube') this.prepYouTube(); else this.prepFile();
        this.emitStatus();
        if (this.active) this.play();
        return;
      }
      this.error = msg;
      this.ready = false;
      this.emitStatus();
      if (this.active && this.ui.onError) this.ui.onError(msg);
    },

    prepFile() {
      const a = new Audio();
      a.preload = 'auto';
      a.loop = true;           // loops if the track is shorter than recovery
      a.addEventListener('canplaythrough', () => { if (this.audio === a) { this.ready = true; this.emitStatus(); } });
      a.addEventListener('playing', () => { if (this.audio === a && this.active && this.ui.onPlaying) this.ui.onPlaying(); });
      a.addEventListener('error', () => { if (this.audio === a) this.fail('the audio file could not be loaded'); });
      a.src = this.file();
      a.load();
      this.audio = a;
    },

    prepYouTube() {
      // We create the iframe ourselves so it carries allow="autoplay" from the
      // start, then hand it to the IFrame Player API.
      const params = new URLSearchParams({
        enablejsapi: '1', playsinline: '1', rel: '0', controls: '1',
        modestbranding: '1', start: String(Math.floor(this.startOffset())),
      });
      if (/^https?:$/.test(location.protocol)) params.set('origin', location.origin);
      const iframe = h('iframe', {
        src: `https://www.youtube.com/embed/${encodeURIComponent(this.yt())}?${params}`,
        allow: 'autoplay; encrypted-media; picture-in-picture',
        title: 'Recovery music', frameborder: '0',
      });
      this.dock.replaceChildren(iframe);
      this.iframe = iframe;
      loadYouTubeApi().then((YT) => {
        if (this.iframe !== iframe) return;   // superseded
        this.player = new YT.Player(iframe, {
          events: {
            onReady: () => {
              if (this.iframe !== iframe) return;
              this.ready = true;
              this.setVolumeFrac(1);
              this.emitStatus();
              if (this.active && !Clock.paused) this.play();
            },
            onStateChange: (e) => this.onYTState(e.data),
            onError: (e) => this.fail(`YouTube error ${e.data} (video unavailable or embedding disabled)`),
          },
        });
      }).catch((err) => { if (this.iframe === iframe) this.fail(err.message); });
    },

    onYTState(st) {
      const p = this.player;
      if (!p) return;
      if (st === 1) {                                     // playing
        if (this.active && Clock.paused) { p.pauseVideo(); return; }
        if (this.active && !p.isMuted() && this.ui.onPlaying) this.ui.onPlaying();
      } else if (st === 0) {                              // ended: loop through recovery
        if (this.active) { p.seekTo(this.startOffset(), true); p.playVideo(); }
        else if (this.testing) this.stopTest();
      }
    },

    /** Unlock audio on a user gesture (mainly for tablets / Safari). */
    prime() {
      const a = this.audio;
      if (this.mode !== 'file' || !a || this.testing) return;
      a.muted = true;
      const p = a.play();
      if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    },

    isAudible() {
      if (this.mode === 'youtube') return !!(this.player && this.ready && this.player.getPlayerState && this.player.getPlayerState() === 1 && !this.player.isMuted());
      if (this.mode === 'file') return !!(this.audio && !this.audio.paused && !this.audio.muted);
      return false;
    },

    play() {
      if (this.mode === 'youtube') {
        if (!this.ready || !this.player) return;          // onReady will call play()
        const p = this.player;
        p.unMute();
        p.setVolume(this.lastVol >= 0 ? this.lastVol : CFG.music.volume);
        if (!this.startedOnce) { p.seekTo(this.startOffset(), true); this.startedOnce = true; }
        p.playVideo();
      } else if (this.mode === 'file' && this.audio) {
        const a = this.audio;
        if (!this.startedOnce) { try { a.currentTime = 0; } catch (e) { /* not seekable yet */ } this.startedOnce = true; }
        const pr = a.play();
        if (pr && pr.catch) pr.catch((err) => { if (err && err.name === 'NotAllowedError' && this.active) this.blocked(); });
      }
    },

    /** Recovery phase begins. */
    startRecovery(ui) {
      this.ui = ui || {};
      this.active = true;
      this.startedOnce = false;
      document.body.classList.toggle('yt-visible', this.mode === 'youtube');
      S.music = { source: this.mode, startedAt: null, blocked: false, error: null };
      if (!this.mode) return;
      if (this.error) { if (this.ui.onError) this.ui.onError(this.error); return; }
      this.setVolumeFrac(CFG.music.fadeInSeconds > 0 ? 0 : 1);
      this.play();
      this.scheduleCheck(dur(0) + (Number(CFG.music.autoplayCheckSeconds) || 2) * 1000, 0);
    },

    /** Check the music actually started; otherwise offer the tap button. */
    scheduleCheck(ms, tries) {
      Timers.after(ms, () => {
        if (!this.active) return;
        if (this.isAudible()) { if (S.music && !S.music.startedAt) S.music.startedAt = new Date(); if (this.ui.onPlaying) this.ui.onPlaying(); return; }
        if (this.error) return;
        const state = this.player && this.player.getPlayerState ? this.player.getPlayerState() : null;
        const loading = (this.mode === 'youtube' && !this.ready) || state === 3; // not ready / buffering
        if (loading && tries < 6) { if (this.ui.onLoading) this.ui.onLoading(); this.scheduleCheck(1000, tries + 1); return; }
        this.blocked();
        this.scheduleCheck(1500, tries + 1);   // keep watching; hides the button once playing
      });
    },

    blocked() {
      if (S && S.music) S.music.blocked = true;
      if (this.ui.onBlocked) this.ui.onBlocked();
    },

    /** Called from the "Tap to start the music" button (a user gesture). */
    userStart() {
      if (this.mode === 'youtube' && this.player) { this.player.unMute(); this.player.playVideo(); }
      else if (this.mode === 'file' && this.audio) { this.audio.muted = false; this.audio.play().catch(() => {}); }
    },

    pause() {
      if (!this.active && !this.testing) return;
      if (this.mode === 'youtube' && this.player && this.ready) this.player.pauseVideo();
      if (this.mode === 'file' && this.audio) this.audio.pause();
    },
    resume() {
      if (!this.active) return;
      this.play();
    },

    /** Volume envelope (fade in / fade out) driven by the session clock, so it
        pauses with the session and reaches silence exactly at the end. */
    envelope(elapsed, remaining) {
      const fi = (Number(CFG.music.fadeInSeconds) || 0) * 1000;
      const fo = (Number(CFG.music.fadeOutSeconds) || 0) * 1000;
      let f = 1;
      if (fi > 0) f = Math.min(f, elapsed / fi);
      if (fo > 0) f = Math.min(f, remaining / fo);
      this.setVolumeFrac(clamp(f, 0, 1));
    },
    setVolumeFrac(f) {
      const vol = Math.round(clamp(Number(CFG.music.volume) || 0, 0, 100) * f);
      if (vol === this.lastVol) return;
      this.lastVol = vol;
      if (this.mode === 'youtube' && this.player && this.ready) this.player.setVolume(vol);
      if (this.mode === 'file' && this.audio) this.audio.volume = vol / 100;
    },

    /** Recovery phase ends: stop immediately (the fade has already run). */
    stopRecovery() {
      if (!this.active) return;
      this.active = false;
      this.ui = {};
      document.body.classList.remove('yt-visible');
      if (this.mode === 'youtube' && this.player && this.ready) { this.player.pauseVideo(); this.player.stopVideo(); }
      if (this.mode === 'file' && this.audio) { this.audio.pause(); try { this.audio.currentTime = 0; } catch (e) {} }
      this.lastVol = -1;
    },

    /** Researcher preview on the setup screen. */
    test() {
      if (this.testing) { this.stopTest(); return false; }
      if (!this.ready) return false;
      this.testing = true;
      this.lastVol = -1;
      this.setVolumeFrac(1);
      document.body.classList.add('yt-visible', 'yt-test');
      if (this.mode === 'youtube') { this.player.unMute(); this.player.seekTo(this.startOffset(), true); this.player.playVideo(); }
      else { this.audio.currentTime = 0; this.audio.play().catch(() => {}); }
      return true;
    },
    stopTest() {
      if (!this.testing) return;
      this.testing = false;
      document.body.classList.remove('yt-visible', 'yt-test');
      if (this.mode === 'youtube' && this.player && this.ready) { this.player.pauseVideo(); this.player.seekTo(this.startOffset(), true); this.player.pauseVideo(); }
      if (this.mode === 'file' && this.audio) { this.audio.pause(); this.audio.currentTime = 0; }
      if (this.statusListener) this.statusListener(this.status());
    },

    destroy() {
      this.stopTest();
      this.stopRecovery();
      if (this.player && this.player.destroy) { try { this.player.destroy(); } catch (e) {} }
      this.dock.replaceChildren();
      if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
      this.player = this.iframe = this.audio = null;
      this.mode = null; this.ready = false; this.error = ''; this.lastVol = -1;
    },
  };

  /* ---- Nature-sound cues for the Quiet group -----------------------------
     Plays CFG.natureCues.count short clips at random moments of the quiet
     recovery (one per equal slot, so they never overlap). Driven by the session
     clock, so it pauses with the session. */
  const Nature = {
    audio: null, cues: [], playingIdx: -1, ok: true,

    cfg() { return CFG.natureCues || {}; },
    files() { return (this.cfg().files || []).map((f) => String(f).trim()).filter(Boolean); },
    enabled() { return !!(this.cfg().enabled && this.files().length); },

    /** Create the audio element early (setup click) so the browser allows playback later. */
    prepare() {
      this.destroy();
      if (!this.enabled()) return;
      const a = new Audio();
      a.preload = 'auto';
      a.loop = true;
      a.volume = 0;
      a.addEventListener('error', () => { this.ok = false; console.warn('[nature] audio file could not be loaded'); });
      a.src = this.files()[0];
      a.load();
      this.audio = a;
      this.ok = true;
      a.muted = true;                                   // unlock on the Start click
      const p = a.play();
      if (p && p.then) p.then(() => { a.pause(); a.currentTime = 0; a.muted = false; }).catch(() => { a.muted = false; });
    },

    /** Choose random start times (ms from recovery start) for this session. */
    plan(totalMs) {
      const c = this.cfg();
      const n = Math.max(0, Math.floor(Number(c.count) || 0));
      const clip = dur(c.seconds || 30), margin = dur(c.marginSeconds || 0);
      const lo = margin, hi = Math.max(lo + clip, totalMs - margin);
      const slot = (hi - lo) / Math.max(1, n);
      const files = this.files();
      this.cues = [];
      for (let i = 0; i < n; i++) {
        const room = Math.max(0, slot - clip);
        this.cues.push({ at: lo + i * slot + Math.random() * room, clip, file: rand(files), started: false, done: false });
      }
      this.playingIdx = -1;
      if (S) S.nature = { planned: this.cues.map((q) => Math.round(q.at / 100) / 10), played: 0 };
    },

    /** Called every tick during quiet recovery. */
    update(elapsed) {
      if (!this.audio || !this.ok) return;
      const c = this.cfg(), a = this.audio;
      const fi = (Number(c.fadeInSeconds) || 0) * 1000, fo = (Number(c.fadeOutSeconds) || 0) * 1000;
      const vol = clamp(Number(c.volume) || 0, 0, 100) / 100;
      this.cues.forEach((q, i) => {
        if (q.done) return;
        if (!q.started && elapsed >= q.at) {
          q.started = true; this.playingIdx = i;
          const f = q.file;
          if (f && !a.src.endsWith(f)) a.src = f;
          try { a.currentTime = 0; } catch (e) { /* not seekable yet */ }
          a.volume = 0;
          const pr = a.play();
          if (pr && pr.catch) pr.catch((err) => console.warn('[nature] play blocked', err && err.name));
          if (S && S.nature) S.nature.played++;
        }
        if (q.started) {
          const t = elapsed - q.at, left = q.clip - t;
          if (left <= 0) { q.done = true; a.pause(); if (this.playingIdx === i) this.playingIdx = -1; return; }
          let f = 1;
          if (fi > 0) f = Math.min(f, t / fi);
          if (fo > 0) f = Math.min(f, left / fo);
          a.volume = clamp(vol * clamp(f, 0, 1), 0, 1);
        }
      });
    },

    /* ---- researcher sound test on the setup screen ---- */
    testAudio: null, testing: false, testTimer: null, onTestChange: null,
    loadTest(cb) {
      this.stopTest();
      if (this.testAudio) { this.testAudio.removeAttribute('src'); this.testAudio = null; }
      if (!this.enabled()) { cb({ state: 'none', text: 'No nature sound is set in config.js (natureCues.files)' }); return; }
      const f = this.files()[0];
      const a = new Audio();
      a.preload = 'auto';
      a.addEventListener('canplaythrough', () => { if (this.testAudio === a) cb({ state: 'ready', text: `${f} · ready` }); });
      a.addEventListener('error', () => { if (this.testAudio === a) cb({ state: 'error', text: `${f}: the audio file could not be loaded` }); });
      a.src = f;
      a.load();
      this.testAudio = a;
      cb({ state: 'loading', text: `${f} · loading…` });
    },
    test() {
      if (this.testing) { this.stopTest(); return false; }
      const a = this.testAudio;
      if (!a) return false;
      const c = this.cfg();
      this.testing = true;
      a.loop = true;
      a.muted = false;
      a.volume = clamp(Number(c.volume) || 0, 0, 100) / 100;
      try { a.currentTime = 0; } catch (e) { /* not seekable yet */ }
      const pr = a.play();
      if (pr && pr.catch) pr.catch(() => this.stopTest());
      this.testTimer = setTimeout(() => this.stopTest(), (Number(c.seconds) || 30) * 1000);
      return true;
    },
    stopTest() {
      if (!this.testing) return;
      this.testing = false;
      clearTimeout(this.testTimer);
      if (this.testAudio) { this.testAudio.pause(); try { this.testAudio.currentTime = 0; } catch (e) {} }
      if (this.onTestChange) this.onTestChange();
    },

    pause() { if (this.audio && this.playingIdx >= 0) this.audio.pause(); },
    resume() { if (this.audio && this.playingIdx >= 0) { const p = this.audio.play(); if (p && p.catch) p.catch(() => {}); } },
    stop() { if (this.audio) this.audio.pause(); this.playingIdx = -1; },
    destroy() {
      this.stopTest();
      if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
      this.audio = null; this.cues = []; this.playingIdx = -1;
    },
  };

  /* =========================================================================
     8. RUNNER (timeline engine)
     A step is a plain object:
       { name, chrome, accent, durationMs, enter(), update(now), exit(),
         onKey(e), onResume() }
     The runner sets step.startAt / step.endAt on the session clock.
     ========================================================================= */
  const Runner = {
    steps: [], i: -1, cur: null, totalMs: 1, doneMs: 0,

    start(steps) {
      this.steps = steps;
      this.totalMs = steps.reduce((a, s) => a + s.durationMs, 0) || 1;
      this.doneMs = 0;
      this.enter(0, Clock.now());
    },

    enter(i, at) {
      this.i = i;
      const s = this.steps[i];
      if (!s) { this.cur = null; finishSession(false); return; }
      this.cur = s;
      s.startAt = at;
      s.endAt = at + s.durationMs;
      s.reached = true;
      logEvent('phase', s.name, at);
      Chrome.set(s.chrome || s.name);
      setPhaseAccent(s.accent);
      s.enter();
      if (this.cur === s && s.update) s.update(Clock.now());
    },

    /** End the current step at session time `at` and start the next one there. */
    advance(at) {
      const s = this.cur;
      if (!s) return;
      this.cur = null;
      try { if (s.exit) s.exit(); } catch (e) { console.error(e); }
      Timers.clear();
      this.doneMs += s.durationMs;
      this.enter(this.i + 1, at);
    },

    /** Finish the current step early (e.g. STAI completed). */
    next() { if (this.cur) this.advance(Clock.now()); },

    /** Is input for this step still allowed? Enforces the strict stop. */
    isLive(step) { return running && this.cur === step && !Clock.paused && Clock.now() < step.endAt; },

    tick() {
      if (!running || Clock.paused) return;
      const now = Clock.now();
      let guard = 0;
      while (this.cur && guard++ < 100) {
        const s = this.cur;
        if (now >= s.endAt) {
          Timers.run(s.endAt - 1e-3);       // timers due before the boundary
          if (this.cur !== s) continue;
          this.advance(s.endAt);            // next phase starts at the exact boundary
        } else {
          Timers.run(now);
          if (this.cur === s) break;
        }
      }
      const c = this.cur;
      if (c) {
        if (c.update) c.update(now);
        Chrome.progress((this.doneMs + clamp(now - c.startAt, 0, c.durationMs)) / this.totalMs);
      }
    },
  };

  /* =========================================================================
     9. STEP FACTORIES
     ========================================================================= */

  /* ---- 9a. Baseline / recovery rest -------------------------------------- */
  function makeRestStep(which) {
    const isRec = which === 'recovery';
    const withMusic = isRec && S.condition === 'music';
    const withNature = isRec && S.condition === 'quiet' && Nature.enabled();
    const copy = isRec ? (withMusic ? CFG.text.recoveryMusic : CFG.text.recoveryQuiet) : CFG.text.baseline;
    let ring, musicSlot;

    const step = {
      name: isRec ? `Recovery (${withMusic ? 'music' : 'quiet rest'})` : 'Baseline rest',
      chrome: isRec ? 'Recovery' : 'Rest',
      accent: isRec ? '#7fc8c0' : '#8fb0ff',
      durationMs: dur(isRec ? T.recoverySeconds : T.baselineSeconds),

      enter() {
        ring = Ring({ size: withMusic ? 'lg' : 'xl' });
        musicSlot = withMusic ? h('div', { class: 'music-slot' }) : null;
        // Deliberately no breathing animation: a paced visual could bias resting physiology.
        showScreen(h('section', { class: `screen screen-rest${withMusic ? ' has-music' : ''}` },
          h('div', { class: 'rest-copy' },
            h('div', { class: 'eyebrow', html: `${withMusic ? ICON.music : ICON.leaf}<span>${copy.eyebrow}</span>` }),
            h('h1', { class: 'display' }, copy.title),
            h('ul', { class: 'cue-list' }, copy.lines.map((l) => h('li', null, l)))),
          ring.el,
          musicSlot));

        if (withNature) Nature.plan(this.durationMs);
        if (withMusic) {
          if (!Music.mode) {
            musicSlot.replaceChildren(h('div', { class: 'music-note', html: `${ICON.alert}<span>No music source is set, so this recovery is quiet rest.</span>` }));
          }
          Music.startRecovery({
            onPlaying: () => musicSlot.replaceChildren(),
            onLoading: () => { if (!musicSlot.firstChild) musicSlot.replaceChildren(h('div', { class: 'music-note subtle' }, 'Music is loading…')); },
            onBlocked: () => {
              if (musicSlot.querySelector('.tap-music')) return;
              const btn = h('button', { class: 'btn btn-primary btn-xl tap-music', html: `${ICON.play}<span>Tap to start the music</span>`, onClick: () => { Music.userStart(); } });
              musicSlot.replaceChildren(btn);
              btn.focus({ preventScroll: true });
            },
            onError: (msg) => {
              if (S.music) S.music.error = msg;
              musicSlot.replaceChildren(h('div', { class: 'music-note', html: `${ICON.alert}<span>The music could not be played (${msg}). Rest quietly.</span>` }));
            },
          });
        }
      },
      update(now) {
        ring.set(this.endAt - now, this.durationMs);
        if (withMusic) Music.envelope(now - this.startAt, this.endAt - now);
        if (withNature) Nature.update(now - this.startAt);
      },
      exit() { if (withMusic) Music.stopRecovery(); if (withNature) Nature.stop(); },
    };
    const restRec = ((S.rest = S.rest || {})[which] = { reached: false, skipped: false, timeSpentMs: null });
    const enter0 = step.enter, exit0 = step.exit;
    step.enter = function () {
      restRec.reached = true;
      enter0.call(this);
      addSkip(step, isRec ? 'Skip recovery' : 'Skip rest', () => { restRec.skipped = true; });
    };
    step.exit = function () {
      restRec.timeSpentMs = Math.round(Math.min(Clock.now(), step.endAt) - step.startAt);
      exit0.call(this);
    };
    return step;
  }

  /* ---- 9b. STAI-6 --------------------------------------------------------- */
  /** Sum with reverse scoring, scaled by 20/6. Null if any item is missing. */
  function staiScore(answers) {
    if (answers.some((a) => a == null)) return null;
    const raw = answers.reduce((sum, v, i) => sum + (CFG.stai.items[i].reverse ? 5 - v : v), 0);
    return raw * CFG.stai.scaleFactor;
  }

  function makeStaiStep(n) {
    const items = CFG.stai.items, opts = CFG.stai.options, last = items.length - 1;
    const rec = { n, answers: items.map(() => null), complete: false, total: null, endedBy: null, reached: false };
    S.stai[n - 1] = rec;
    let q = 0, advId = null, ring, qWrap, dots;

    const step = {
      name: `STAI-6 #${n}`, chrome: 'Questionnaire', accent: '#9fb2e8',
      durationMs: dur(T.staiSeconds),

      enter() {
        rec.reached = true;
        ring = Ring({ size: 'sm' });
        dots = h('div', { class: 'stai-dots', 'aria-hidden': 'true' }, items.map(() => h('span')));
        qWrap = h('div', { class: 'stai-q' });
        showScreen(h('section', { class: 'screen screen-stai' },
          h('header', { class: 'stai-head' },
            h('div', { class: 'eyebrow', html: `${ICON.clipboard}<span>Questionnaire</span>` }),
            dots,
            h('div', { class: 'stai-timer' }, h('span', { class: 'tiny' }, 'Time left'), ring.el)),
          h('p', { class: 'stai-prompt' }, CFG.stai.prompt),
          qWrap,
          h('footer', { class: 'key-hints' },
            h('span', null, h('kbd', null, '1'), '–', h('kbd', null, '4'), ' answer'),
            h('span', null, h('kbd', null, 'Enter'), ' next'),
            h('span', null, h('kbd', null, '←'), ' back'))));
        render(0);
      },
      update(now) { ring.set(this.endAt - now, this.durationMs); },
      exit() {
        if (!rec.complete) { rec.total = null; rec.endedBy = 'timeout'; }
      },
      onKey(e) {
        if (!Runner.isLive(step)) return;
        const n = Number(e.key);
        if (n >= 1 && n <= opts.length && !e.repeat) { e.preventDefault(); choose(opts[n - 1].value); }
        else if (e.key === 'Enter') { e.preventDefault(); forward(); }
        else if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); go(q - 1, 'back'); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); if (rec.answers[q] != null && q < last) go(q + 1, 'fwd'); }
      },
    };

    function render(dir) {
      const ans = rec.answers[q];
      const optionBtns = opts.map((o, i) => h('button', {
        class: `opt${ans === o.value ? ' is-selected' : ''}`, role: 'radio',
        'aria-checked': ans === o.value ? 'true' : 'false',
        onClick: () => choose(o.value),
      }, h('span', { class: 'opt-key' }, String(i + 1)), h('span', { class: 'opt-label' }, o.label)));

      const nav = h('div', { class: 'q-nav' },
        q > 0 ? h('button', { class: 'btn btn-ghost', onClick: () => go(q - 1, 'back') }, '← Back') : h('span'),
        q === last
          ? h('button', { class: 'btn btn-primary btn-lg save-btn', disabled: ans == null || null, onClick: save, html: `${ICON.check}<span>Save</span>` })
          : (ans != null ? h('button', { class: 'btn btn-ghost', onClick: () => go(q + 1, 'fwd') }, 'Next →') : h('span')));

      qWrap.replaceChildren(h('div', { class: `q-card${dir ? ` slide-${dir}` : ''}` },
        h('div', { class: 'q-num' }, `Question ${q + 1} of ${items.length}`),
        h('h2', { class: 'q-text' }, items[q].text),
        h('div', { class: 'q-options', role: 'radiogroup', 'aria-label': items[q].text }, optionBtns),
        nav));

      [...dots.children].forEach((d, i) => {
        d.className = (rec.answers[i] != null ? 'is-done ' : '') + (i === q ? 'is-current' : '');
      });
    }

    function choose(value) {
      if (!Runner.isLive(step)) return;
      rec.answers[q] = value;
      if (advId) { Timers.cancel(advId); advId = null; }
      render();
      if (q < last) {
        advId = Timers.after(T.staiAutoAdvanceMs, () => { advId = null; go(q + 1, 'fwd'); });
      } else {
        const sb = qWrap.querySelector('.save-btn');
        if (sb) sb.focus({ preventScroll: true });
      }
    }

    function go(i, dir) {
      if (!Runner.isLive(step) || i < 0 || i > last) return;
      if (advId) { Timers.cancel(advId); advId = null; }
      q = i;
      render(dir);
    }

    function forward() {
      if (rec.answers[q] == null) return;
      if (q < last) go(q + 1, 'fwd'); else save();
    }

    function save() {
      if (!Runner.isLive(step)) return;
      const first = rec.answers.findIndex((a) => a == null);
      if (first !== -1) { go(first, 'back'); return; }   // an earlier item is unanswered
      rec.complete = true;
      rec.total = staiScore(rec.answers);
      rec.endedBy = 'saved';
      rec.durationMs = Math.round(Clock.now() - step.startAt);
      Runner.next();                                        // finished early: move on now
    }

    return step;
  }

  /* ---- 9c. Task instruction card ----------------------------------------- */
  function makeInstructionStep(task, pos, count) {
    let ring;
    const step = {
      name: `${task.label}: instructions`, chrome: `Task ${pos} of ${count}`, accent: task.accent,
      durationMs: dur(T.taskInstructionSeconds),
      enter() {
        ring = Ring({ size: 'md', seconds: true, caption: 'starts in' });
        showScreen(h('section', { class: 'screen screen-instr', style: `--task:${task.accent}` },
          h('article', { class: 'instr-card' },
            h('div', { class: 'instr-top' },
              h('div', { class: 'task-chip', html: `${ICON[task.icon] || ''}<span>${task.label}</span>` }),
              h('span', { class: 'task-pos' }, `Task ${pos} of ${count}`)),
            h('h1', { class: 'instr-title' }, task.title),
            h('ol', { class: 'rules' }, (task.rules || []).map((r) => h('li', null, fill(r, ruleValues(task))))),
            h('div', { class: 'instr-foot' },
              ring.el,
              h('div', null, h('strong', null, 'Get ready'), h('span', null, 'The task starts automatically.'))))));
        addSkip(step, 'Skip to task', () => { if (S.tasks[task.id]) S.tasks[task.id].instructionSkipped = true; });
      },
      update(now) { ring.set(this.endAt - now, this.durationMs); },
    };
    return step;
  }

  /* ---- 9d. Tasks ------------------------------------------------------------ */
  function makeTaskStep(task, pos, count) {
    const rec = { id: task.id, kind: task.kind, label: task.label, title: task.title, position: pos, reached: false, correct: 0, wrong: 0, missed: 0, responses: [] };
    S.tasks[task.id] = rec;
    const step = { name: task.label, chrome: `Task ${pos} of ${count}`, accent: task.accent, durationMs: dur(T.taskSeconds) };
    const impl = { serial: serialTask, stroop: stroopTask, speaking: speakingTask, reading: readingTask }[task.kind];
    if (!impl) throw new Error(`Unknown task kind "${task.kind}" for task ${task.id}`);
    const parts = impl(task, rec, step, pos, count);
    const enter = parts.enter;
    const exit0 = parts.exit;
    parts.exit = function () {
      rec.timeSpentMs = Math.round(Math.min(Clock.now(), step.endAt) - step.startAt);
      if (exit0) exit0.call(this);
    };
    parts.enter = function () {
      rec.reached = true;
      enter.call(this);
      addSkip(step, 'Skip task', () => { rec.skipped = true; rec.skippedAtMs = Math.round(Clock.now() - step.startAt); });
    };
    return Object.assign(step, parts);
  }

  /** Task A / B: serial subtraction (optionally with a visual beat). */
  function serialTask(task, rec, step, pos, count) {
    let last = task.start, ring, input, numEl, msgEl, entry;
    rec.start = task.start; rec.step = task.step;

    function submit() {
      if (!Runner.isLive(step)) return;
      const raw = input.value.trim();
      if (!raw || raw === '-') return;
      const value = Number(raw), expected = last - task.step;
      const ok = value === expected;
      rec.responses.push({ t: Math.round(Clock.now() - step.startAt), value, expected, correct: ok });
      if (ok) {
        last = expected; rec.correct++;
        numEl.textContent = String(last);
        bump(numEl, 'is-pop');
        msgEl.textContent = ''; msgEl.className = 'serial-msg';
      } else {
        rec.wrong++;
        msgEl.textContent = `${raw} is not correct. Try again.`;
        msgEl.className = 'serial-msg is-error';
        bump(entry, 'is-shake');
      }
      input.value = '';
    }

    return {
      enter() {
        ring = Ring({ size: 'md' });
        input = h('input', {
          class: 'serial-input', type: 'text', inputmode: 'numeric', autocomplete: 'off',
          autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '7',
          'aria-label': 'Type the next number and press Enter',
        });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        input.addEventListener('input', () => { input.value = input.value.replace(/[^\d-]/g, ''); });
        // The input always keeps focus while the task is live.
        input.addEventListener('blur', () => setTimeout(() => { if (Runner.isLive(step)) input.focus({ preventScroll: true }); }, 0));

        numEl = h('div', { class: 'serial-last' }, String(last));
        msgEl = h('div', { class: 'serial-msg', role: 'status', 'aria-live': 'assertive' });
        entry = h('div', { class: 'serial-entry' }, input, h('span', { class: 'enter-hint' }, 'Enter ↵'));

        const arithmetic = h('div', { class: 'serial' },
          h('div', { class: 'serial-label' }, 'Last correct number'),
          numEl,
          h('div', { class: 'serial-op' }, `subtract ${task.step}`),
          entry, msgEl);

        const beat = task.pulseBpm
          ? h('div', { class: 'pulse-wrap' },
              h('div', { class: 'pulse', style: `--beat:${(60 / task.pulseBpm).toFixed(3)}s` },
                h('span', { class: 'pulse-ring' }), h('span', { class: 'pulse-core' })),
              h('div', { class: 'pulse-label' }, 'Tap the beat with your free hand'))
          : null;

        showScreen(h('section', { class: `screen screen-task task-${task.kind}`, style: `--task:${task.accent}` },
          taskHeader(task, pos, count, ring),
          h('div', { class: `task-body${beat ? ' two-col' : ''}` }, arithmetic, beat)));
        requestAnimationFrame(() => input.focus({ preventScroll: true }));
      },
      update(now) { ring.set(step.endAt - now, step.durationMs); },
      onResume() { input.focus({ preventScroll: true }); },
      exit() { input.disabled = true; rec.lastCorrect = last; },
    };
  }

  /** Task C: Stroop. */
  function stroopTask(task, rec, step, pos, count) {
    const colors = task.colors;
    const trialMs = task.trialSeconds * 1000;
    let ring, wordEl, fbEl, btnMap = {}, trial = null, timeoutId = null, block = [], lastPair = '';
    rec.trials = [];

    /** A shuffled block with an exact incongruent share, e.g. 8 of 10. */
    function newBlock() {
      const n = Math.max(1, task.blockSize || 10);
      const inc = Math.round(n * task.incongruentRatio);
      return shuffle([...Array(inc).fill(true), ...Array(n - inc).fill(false)]);
    }

    function makeTrial() {
      if (!block.length) block = newBlock();
      const incongruent = block.pop();
      let word, ink;
      for (let k = 0; k < 20; k++) {           // avoid repeating the exact same stimulus
        word = rand(colors);
        ink = incongruent ? rand(colors.filter((c) => c !== word)) : word;
        if (`${word.name}|${ink.name}` !== lastPair) break;
      }
      lastPair = `${word.name}|${ink.name}`;
      return { word: word.name, ink: ink.name, inkHex: ink.hex, congruent: !incongruent };
    }

    function showTrial(at) {
      if (!running || Runner.cur !== step) return;
      trial = makeTrial();
      trial.shownAt = at;
      trial.t = Math.round(at - step.startAt);
      wordEl.textContent = trial.word.toUpperCase();
      wordEl.style.color = trial.inkHex;
      wordEl.className = 'stroop-word is-in';
      fbEl.textContent = ''; fbEl.className = 'stroop-fb';
      timeoutId = Timers.at(at + trialMs, (due) => {      // word disappears at 2.5 s
        trial.response = null; trial.missed = true; trial.correct = false;
        rec.missed++;
        endTrial(due, 'Too slow', 'is-slow');
      });
    }

    function respond(name) {
      if (!trial || !Runner.isLive(step)) return;
      Timers.cancel(timeoutId);
      const now = Clock.now();
      trial.response = name;
      trial.rt = Math.round(now - trial.shownAt);
      trial.correct = name === trial.ink;
      if (trial.correct) rec.correct++; else rec.wrong++;
      const b = btnMap[name]; if (b) bump(b, 'is-pressed');
      endTrial(now, trial.correct ? '✓' : 'Wrong', trial.correct ? 'is-good' : 'is-bad');
    }

    function endTrial(at, text, cls) {
      rec.trials.push(trial);
      trial = null;
      wordEl.className = 'stroop-word is-out';
      fbEl.textContent = text; fbEl.className = `stroop-fb ${cls}`;
      Timers.at(at + task.feedbackMs, showTrial);
    }

    return {
      enter() {
        ring = Ring({ size: 'md' });
        wordEl = h('div', { class: 'stroop-word', 'aria-live': 'off' });
        fbEl = h('div', { class: 'stroop-fb', role: 'status' });
        const btns = colors.map((c) => {
          const b = h('button', { class: 'stroop-btn', style: `--c:${c.hex}`, onClick: () => respond(c.name), 'aria-label': `${c.name} (${c.key})` },
            h('span', { class: 'swatch' }), h('span', { class: 'stroop-name' }, c.name), h('kbd', null, c.key));
          btnMap[c.name] = b;
          return b;
        });
        showScreen(h('section', { class: 'screen screen-task task-stroop', style: `--task:${task.accent}` },
          taskHeader(task, pos, count, ring),
          h('div', { class: 'task-body' },
            h('div', { class: 'stroop-hint' }, 'Choose the colour of the ', h('strong', null, 'ink')),
            h('div', { class: 'stroop-stage' }, wordEl),
            fbEl,
            h('div', { class: 'stroop-btns' }, btns))));
        Timers.at(step.startAt + 350, showTrial);   // short settle before the first word
      },
      update(now) { ring.set(step.endAt - now, step.durationMs); },
      onKey(e) {
        if (e.repeat) return;
        const k = e.key.length === 1 ? e.key.toUpperCase() : '';
        const c = colors.find((x) => x.key.toUpperCase() === k);
        if (c) { e.preventDefault(); respond(c.name); }
      },
      exit() { /* a trial cut off by the strict stop is not counted */ trial = null; },
    };
  }

  /** Task D: speaking (no recording claims). */
  function speakingTask(task, rec, step, pos, count) {
    let ring;
    return {
      enter() {
        ring = Ring({ size: 'xl' });
        showScreen(h('section', { class: 'screen screen-task task-speaking', style: `--task:${task.accent}` },
          taskHeader(task, pos, count, Ring({ size: 'sm' })),
          h('div', { class: 'task-body speak' },
            h('h2', { class: 'speak-prompt' }, task.prompt),
            ring.el,
            h('p', { class: 'speak-sub' }, task.subPrompt))));
        // the header ring is decorative here; the big ring is the countdown
        const small = $('.task-timer', stage.lastChild); if (small) small.remove();
      },
      update(now) { ring.set(step.endAt - now, step.durationMs); },
      exit() { rec.completed = true; },
    };
  }

  /** Task E: read for the first part, then explain. */
  function readingTask(task, rec, step, pos, count) {
    const passages = task.passages || [];
    const idx = Math.floor(Math.random() * passages.length);
    rec.passage = idx + 1;
    const splitMs = Math.min(dur(task.readSeconds), step.durationMs);
    let ring, body, readLeft, readBar, phase = 'read';

    function toExplain() {
      if (phase !== 'read') return;
      phase = 'explain';
      logEvent('task-part', `${task.label}: explain`);
      body.replaceChildren(h('div', { class: 'explain' },
        h('div', { class: 'eyebrow', html: `${ICON.speech}<span>Part 2 · Explain</span>` }),
        h('h2', { class: 'explain-prompt' }, task.explainPrompt)));
    }

    return {
      enter() {
        ring = Ring({ size: 'md' });
        readLeft = h('span', null, '');
        readBar = h('div', { class: 'read-bar-fill' });
        body = h('div', { class: 'task-body reading' },
          h('div', { class: 'read-meta' },
            h('div', { class: 'eyebrow', html: `${ICON.book}<span>Part 1 · Read</span>` }),
            h('div', { class: 'read-left' }, 'Passage disappears in ', readLeft)),
          h('div', { class: 'read-bar' }, readBar),
          h('p', { class: 'passage' }, passages[idx] || ''));
        showScreen(h('section', { class: 'screen screen-task task-reading', style: `--task:${task.accent}` },
          taskHeader(task, pos, count, ring), body));
        Timers.at(step.startAt + splitMs, toExplain);
      },
      update(now) {
        ring.set(step.endAt - now, step.durationMs);
        if (phase === 'read') {
          const left = step.startAt + splitMs - now;
          readLeft.textContent = fmtClock(left);
          readBar.style.transform = `scaleX(${clamp(left / splitMs, 0, 1)})`;
        }
      },
    };
  }

  /* ---- 9e. Final question ------------------------------------------------- */
  function makeFinalStep() {
    let ring, chosen = null, list;
    const step = {
      name: 'Final question', chrome: 'Final question', accent: '#9fb2e8',
      durationMs: dur(T.finalQuestionSeconds),
      enter() {
        ring = Ring({ size: 'sm' });
        list = h('div', { class: 'final-list', role: 'radiogroup' },
          S.taskOrder.map((id, i) => {
            const t = CFG.tasks[id];
            return h('button', { class: 'final-opt', style: `--task:${t.accent}`, 'data-id': id, role: 'radio', 'aria-checked': 'false', onClick: () => choose(id) },
              h('span', { class: 'opt-key' }, String(i + 1)),
              h('span', { class: 'final-icon', html: ICON[t.icon] || '' }),
              h('span', { class: 'final-text' }, h('strong', null, t.label), h('span', null, t.title)));
          }));
        showScreen(h('section', { class: 'screen screen-final' },
          h('header', { class: 'stai-head' },
            h('div', { class: 'eyebrow', html: `${ICON.flag}<span>One last question</span>` }),
            h('span'),
            h('div', { class: 'stai-timer' }, h('span', { class: 'tiny' }, 'Time left'), ring.el)),
          h('h1', { class: 'final-q' }, CFG.finalQuestion.prompt),
          h('p', { class: 'muted center' }, 'Tasks are listed in the order you did them.'),
          list,
          h('footer', { class: 'key-hints' }, h('span', null, 'Click, or press ', h('kbd', null, '1'), '–', h('kbd', null, String(S.taskOrder.length))))));
      },
      update(now) { ring.set(this.endAt - now, this.durationMs); },
      onKey(e) {
        const n = Number(e.key);
        if (n >= 1 && n <= S.taskOrder.length) { e.preventDefault(); choose(S.taskOrder[n - 1]); }
      },
    };
    function choose(id) {
      if (chosen || !Runner.isLive(step)) return;
      chosen = id;
      S.mostStressful = id;
      for (const b of list.children) {
        const on = b.dataset.id === id;
        b.classList.toggle('is-selected', on);
        b.classList.toggle('is-dim', !on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }
      Timers.after(800, () => Runner.next());
    }
    return step;
  }

  /* =========================================================================
     10. SESSION START / PAUSE / END
     ========================================================================= */

  /** Random order with constraints from CFG.neverAdjacent. */
  function randomTaskOrder() {
    const pairs = (CFG.neverAdjacent || []).filter((p) => TASK_IDS.includes(p[0]) && TASK_IDS.includes(p[1]));
    const ok = (o) => o.every((id, i) => i === 0 || !pairs.some(([a, b]) => (o[i - 1] === a && id === b) || (o[i - 1] === b && id === a)));
    for (let k = 0; k < 5000; k++) {
      const o = shuffle(TASK_IDS);
      if (ok(o)) return o;
    }
    console.warn('neverAdjacent constraint could not be met; using an unconstrained order');
    return shuffle(TASK_IDS);
  }

  function buildTimeline() {
    const order = S.taskOrder, n = order.length;
    const steps = [makeRestStep('baseline'), makeStaiStep(1)];
    order.forEach((id, i) => {
      const task = Object.assign({ id }, CFG.tasks[id]);
      steps.push(makeInstructionStep(task, i + 1, n), makeTaskStep(task, i + 1, n));
    });
    steps.push(makeStaiStep(2), makeRestStep('recovery'), makeStaiStep(3), makeFinalStep());
    return steps;
  }

  /** Longest possible session (STAI and final question may end sooner). */
  function estimateSeconds() {
    const n = TASK_IDS.length;
    return (T.baselineSeconds + 3 * T.staiSeconds + n * (T.taskInstructionSeconds + T.taskSeconds) +
      T.recoverySeconds + T.finalQuestionSeconds) / SPEED;
  }

  /* ---- fullscreen, keyboard lock, wake lock ---- */
  let wakeLock = null;
  const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  function enterFullscreen() {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req || isFullscreen()) { lockEsc(); return; }
    try {
      const p = req.call(el, { navigationUI: 'hide' });
      if (p && p.then) p.then(lockEsc).catch(() => {});
    } catch (e) { /* not allowed */ }
  }
  /** Chrome / Edge: lets Esc reach the page instead of only exiting fullscreen. */
  function lockEsc() {
    if (navigator.keyboard && navigator.keyboard.lock && isFullscreen()) navigator.keyboard.lock(['Escape']).catch(() => {});
  }
  function exitFullscreen() {
    if (navigator.keyboard && navigator.keyboard.unlock) navigator.keyboard.unlock();
    if (!isFullscreen()) return;
    try {
      const p = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      if (p && p.catch) p.catch(() => {});
    } catch (e) { /* ignore */ }
  }
  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible' && !wakeLock) requestWakeLock(); });

  /** Called from the Start button (a user gesture). */
  function startSession(condition, participantId, week, order) {
    enterFullscreen();               // must run synchronously inside the click
    if (condition === 'music') { Music.stopTest(); Music.prepare(); Music.prime(); }
    else Music.destroy();
    if (condition === 'quiet') Nature.prepare(); else Nature.destroy();
    requestWakeLock();

    S = newSessionRecord(condition, week);
    S.participantId = participantId || '';
    S.orderMode = order && order.length ? 'fixed' : 'random';
    S.taskOrder = S.orderMode === 'fixed' ? order.slice() : randomTaskOrder();
    const steps = buildTimeline();

    Clock.start();
    running = true;
    S.startedAt = new Date();
    document.body.classList.remove('is-paused');
    Chrome.progress(0);
    Chrome.show();
    Ticker.start();
    Runner.start(steps);
  }

  function pauseSession(reason) {
    if (!running || Clock.paused) return;
    Clock.pause();
    Music.pause();
    Nature.pause();
    logEvent('pause', reason || 'Esc');
    document.body.classList.add('is-paused');
    stage.inert = true;
    showPauseOverlay(reason);
  }

  function resumeSession(fromGesture) {
    if (!running || !Clock.paused) return;
    const ov = $('.overlay-pause', overlayRoot);
    if (ov) { ov.classList.add('is-leaving'); setTimeout(() => ov.remove(), 250); }
    if (fromGesture) enterFullscreen(); else lockEsc();
    stage.inert = false;
    document.body.classList.remove('is-paused');
    Clock.resume();
    logEvent('resume', '');
    Music.resume();
    Nature.resume();
    const c = Runner.cur;
    if (c && c.onResume) c.onResume();
    Runner.tick();
  }

  function showPauseOverlay(reason) {
    const resumeBtn = h('button', { class: 'btn btn-primary btn-xl', html: `${ICON.play}<span>Resume</span>`, onClick: () => resumeSession(true) });
    const endBtn = h('button', {
      class: 'btn btn-ghost-danger', onClick: async () => {
        const ok = await confirmDialog({
          title: 'End the session now?',
          body: 'The session stops here and the results collected so far are shown. This cannot be undone.',
          confirmText: 'End session', cancelText: 'Keep paused', danger: true,
        });
        if (ok) finishSession(true); else resumeBtn.focus();
      },
    }, 'End session…');
    overlayRoot.append(h('div', { class: 'overlay overlay-pause', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Session paused' },
      h('div', { class: 'pause-card' },
        h('div', { class: 'pause-icon', html: ICON.pause }),
        h('h2', null, 'Session paused'),
        h('p', { class: 'muted' }, 'All timers, task input and music are on hold. Resuming continues exactly where it stopped.'),
        reason === 'fullscreen' ? h('p', { class: 'pause-note' }, 'Fullscreen was exited. Resume to return to fullscreen.') : null,
        h('div', { class: 'pause-actions' }, resumeBtn, endBtn),
        h('p', { class: 'tiny muted' }, 'Press Esc again to resume.'))));
    resumeBtn.focus();
  }

  function finishSession(aborted) {
    if (!running) return;
    if (aborted && Runner.cur) {
      try { if (Runner.cur.exit) Runner.cur.exit(); } catch (e) { console.error(e); }
    }
    Runner.cur = null;
    running = false;
    Timers.clear();
    Ticker.stop();
    Music.stopRecovery();
    Nature.stop();
    S.aborted = !!aborted;
    logEvent('end', aborted ? 'Ended early by researcher' : 'Completed');
    S.endedAt = new Date();
    Clock.stop();
    overlayRoot.replaceChildren();
    dialogOpen = null;
    stage.inert = false;
    document.body.classList.remove('is-paused');
    Chrome.hide();
    exitFullscreen();
    releaseWakeLock();
    DataSink.save(S);
    renderEnd();
  }

  /* =========================================================================
     11. SCREENS: LOGIN, SETUP, END
     ========================================================================= */
  let lastCondition = 'music';
  let lastWeek = (CFG.weeks && CFG.weeks[0]) || '';
  let lastOrderMode = 'random';
  let lastCustomOrder = TASK_IDS.join(', ');

  function renderLogin() {
    setPhaseAccent('#8fb0ff');
    const user = h('input', { id: 'login-user', type: 'text', autocomplete: 'username', autocapitalize: 'off', spellcheck: 'false', required: true });
    const pass = h('input', { id: 'login-pass', type: 'password', autocomplete: 'current-password', required: true });
    const err = h('div', { class: 'form-error', role: 'alert', 'aria-live': 'assertive' });
    const card = h('form', {
      class: 'card login-card', novalidate: true,
      onSubmit: (e) => {
        e.preventDefault();
        const okUser = user.value.trim().toLowerCase() === String(CFG.auth.username).toLowerCase();
        const okPass = pass.value === String(CFG.auth.password);
        if (okUser && okPass) { renderSetup(); return; }
        err.innerHTML = `${ICON.alert}<span>Incorrect username or password. Please try again.</span>`;
        pass.value = '';
        bump(card, 'is-shake');
        pass.focus();
      },
    },
      h('div', { class: 'brand', html: ICON.pulse }),
      h('h1', null, CFG.appTitle),
      h('p', { class: 'muted' }, 'Researcher sign-in'),
      h('label', { class: 'field' }, h('span', null, 'Username'), user),
      h('label', { class: 'field' }, h('span', null, 'Password'), pass),
      err,
      h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'submit' }, 'Sign in'),
      h('p', { class: 'tiny muted center', html: `${ICON.lock}<span>STAI-6 answers are sent to your Google Sheet when a session ends.</span>` }));
    showScreen(h('section', { class: 'screen screen-login' }, card));
    setTimeout(() => user.focus(), 50);
  }

  function renderSetup() {
    setPhaseAccent('#8fb0ff');
    let condition = lastCondition;
    let orderMode = lastOrderMode;

    // Recovery condition (segmented control built from real radio inputs)
    const seg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Recovery phase condition' },
      [['music', 'Music group', ICON.music], ['quiet', 'Quiet rest group', ICON.leaf]].map(([val, label, ic]) =>
        h('label', { class: 'seg' },
          h('input', { type: 'radio', name: 'cond', value: val, checked: val === condition || null, onChange: () => setCondition(val) }),
          h('span', { html: `${ic}<span>${label}</span>` }))));

    // Checklist
    const items = [
      ['Sensors streaming', 'EEG contact quality is good'],
      ['Recordings started', 'Recording is running on all devices'],
      ['Participant settled', 'Seated comfortably, sensor hand resting'],
      ['Sound and notifications', 'Volume set, notifications off'],
    ];
    const boxes = [];
    const checklist = h('div', { class: 'checklist' }, items.map(([title, sub], i) => {
      const box = h('input', { type: 'checkbox', onChange: update });
      boxes.push(box);
      return h('label', { class: 'check' }, box,
        h('span', { class: 'check-box', html: ICON.check }),
        h('span', { class: 'check-text' }, h('strong', null, `${String.fromCharCode(97 + i)}. ${title}`), h('span', null, sub)));
    }));
    const progressTxt = h('span', { class: 'tiny muted' });

    // Music status + preview
    const musicStatus = h('div', { class: 'music-status' });
    const testBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', html: `${ICON.volume}<span>Test sound</span>`, onClick: () => {
      const on = Music.test();
      testBtn.querySelector('span').textContent = on ? 'Stop test' : 'Test sound';
    } });
    const musicBox = h('div', { class: 'music-box' }, musicStatus, testBtn);

    // Nature-sound preview (Quiet group)
    const natureStatus = h('div', { class: 'music-status' });
    const natureBtn = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: true, html: `${ICON.volume}<span>Test sound</span>`, onClick: () => {
      const on = Nature.test();
      natureBtn.querySelector('span').textContent = on ? 'Stop test' : 'Test sound';
    } });
    Nature.onTestChange = () => { natureBtn.querySelector('span').textContent = 'Test sound'; };
    const natureBox = h('div', { class: 'music-box' }, natureStatus, natureBtn);
    const paintNature = (st) => {
      natureStatus.className = `music-status is-${st.state}`;
      natureStatus.innerHTML = `${st.state === 'error' || st.state === 'none' ? ICON.alert : ICON.leaf}<span>Nature sound (plays ${(CFG.natureCues && CFG.natureCues.count) || 0}× during recovery): ${st.text}</span>`;
      natureBtn.disabled = st.state !== 'ready';
    };

    // Session length breakdown
    const n = TASK_IDS.length;
    const rows = [
      ['Baseline rest', T.baselineSeconds],
      ['STAI-6 × 3 (up to)', 3 * T.staiSeconds],
      [`Stress block: ${n} tasks × (${T.taskInstructionSeconds} s + ${T.taskSeconds} s)`, n * (T.taskInstructionSeconds + T.taskSeconds)],
      ['Recovery', T.recoverySeconds],
      ['Final question (up to)', T.finalQuestionSeconds],
    ];

    // Task order: random each session, or one fixed order chosen here
    const orderSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Task order' },
      [['random', 'Random order'], ['custom', 'Set my own order']].map(([val, label]) =>
        h('label', { class: 'seg' },
          h('input', { type: 'radio', name: 'ord', value: val, checked: val === orderMode || null, onChange: () => setOrder(val) }),
          h('span', null, label))));
    const orderInput = h('input', { type: 'text', value: lastCustomOrder, autocomplete: 'off', spellcheck: 'false', maxlength: '24', onInput: () => update() });
    const orderErr = h('div', { class: 'form-error' });
    const orderBox = h('div', { class: 'order-box', hidden: orderMode !== 'custom' || null },
      h('label', { class: 'field' }, h('span', null, 'Order, task letters separated by commas'), orderInput),
      h('p', { class: 'tiny muted' }, TASK_IDS.map((id) => `${id} = ${CFG.tasks[id].label}`).join('  ·  ')),
      orderErr);
    function parseOrder() {
      let ids = orderInput.value.toUpperCase().split(/[\s,;>-]+/).filter(Boolean);
      if (ids.length === 1 && ids[0].length > 1) ids = ids[0].split('');
      const ok = ids.length === TASK_IDS.length && new Set(ids).size === ids.length && ids.every((i) => TASK_IDS.includes(i));
      return ok ? ids : null;
    }
    function setOrder(val) { orderMode = lastOrderMode = val; orderBox.hidden = val !== 'custom'; update(); }
    const pidInput = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', maxlength: '40', placeholder: 'e.g. P012', onInput: () => update() });
    const weekSelect = h('select', { 'aria-label': 'Session week', onChange: () => { lastWeek = weekSelect.value; } },
      (CFG.weeks || []).map((w) => h('option', { value: w, selected: w === lastWeek || null }, w)));
    const startBtn = h('button', { class: 'btn btn-primary btn-xl btn-block start-btn', disabled: true, html: `${ICON.play}<span>Start session</span>`, onClick: () => startSession(condition, pidInput.value.trim(), weekSelect.value, orderMode === 'custom' ? parseOrder() : null) });

    function update() {
      const done = boxes.filter((b) => b.checked).length;
      let orderOk = true;
      if (orderMode === 'custom') {
        orderOk = !!parseOrder();
        orderErr.textContent = orderOk ? '' : `Use each of ${TASK_IDS.join(', ')} exactly once, e.g. ${TASK_IDS.join(', ')}.`;
        lastCustomOrder = orderInput.value;
      }
      startBtn.disabled = done !== boxes.length || !orderOk || !pidInput.value.trim();
      progressTxt.textContent = done === boxes.length ? 'All checks complete' : `${done} of ${boxes.length} checks complete`;
    }
    function setCondition(val) {
      condition = lastCondition = val;
      musicBox.hidden = val !== 'music';
      natureBox.hidden = val !== 'quiet';
      if (val === 'music') Music.prepare(); else Music.stopTest();
      if (val === 'quiet') Nature.loadTest(paintNature); else Nature.stopTest();
    }
    Music.statusListener = (st) => {
      musicStatus.className = `music-status is-${st.state}`;
      musicStatus.innerHTML = `${st.state === 'error' || st.state === 'none' ? ICON.alert : ICON.music}<span>${st.text}</span>`;
      testBtn.disabled = st.state !== 'ready';
      if (!Music.testing) testBtn.querySelector('span').textContent = 'Test sound';
    };

    showScreen(h('section', { class: 'screen screen-setup' },
      h('div', { class: 'setup-grid' },
        h('div', { class: 'card setup-main' },
          h('div', { class: 'eyebrow', html: `${ICON.shield}<span>Researcher setup</span>` }),
          h('h1', null, 'Prepare the session'),
          h('div', { class: 'setup-section' },
            h('h3', null, 'Participant'),
            h('label', { class: 'field' }, h('span', null, 'Participant ID (saved with the data)'), pidInput),
            h('label', { class: 'field' }, h('span', null, 'Week'), weekSelect)),
          h('div', { class: 'setup-section' },
            h('h3', null, 'Session group'),
            h('p', { class: 'tiny muted' }, `Sets the ${fmtLength(T.recoverySeconds)} recovery phase: music (local audio file) or quiet rest with short nature-sound cues.`),
            seg, musicBox, natureBox),
          h('div', { class: 'setup-section' },
            h('h3', null, 'Task order'),
            orderSeg, orderBox),
          h('div', { class: 'setup-section' },
            h('div', { class: 'section-head' }, h('h3', null, 'Pre-session checklist'), progressTxt),
            checklist)),
        h('aside', { class: 'card setup-side' },
          h('div', { class: 'eyebrow', html: `${ICON.clock}<span>Estimated length</span>` }),
          h('div', { class: 'big-length' }, fmtLength(estimateSeconds())),
          h('p', { class: 'tiny muted' }, 'Maximum. Questionnaires move on as soon as they are completed.'),
          h('ul', { class: 'breakdown' }, rows.map(([l, s]) => h('li', null, h('span', null, l), h('span', null, fmtLength(s / SPEED))))),
          h('div', { class: 'esc-note', html: `<kbd>Esc</kbd><span>pauses the session at any time. You will not need to click anything after Start.</span>` }),
          startBtn,
          h('p', { class: 'tiny muted center' }, 'Start enters fullscreen and runs the whole session automatically.')))));
    setCondition(condition);
    update();
  }

  function renderEnd() {
    setPhaseAccent('#8fb0ff');
    Music.destroy();
    Nature.destroy();
    const [s1, s2, s3] = S.stai.map((r) => (r && r.complete ? r.total : null));
    const reactivity = s1 != null && s2 != null ? s2 - s1 : null;
    const recovery = s2 != null && s3 != null ? s2 - s3 : null;
    const pct = reactivity != null && recovery != null && reactivity !== 0 ? (recovery / reactivity) * 100 : null;
    const sign = (v) => (v > 0 ? '+' : '');

    const staiCard = (r, i) => {
      const v = r && r.complete ? r.total : null;
      const answered = r ? r.answers.filter((a) => a != null).length : 0;
      return h('div', { class: `stat${v == null ? ' is-missing' : ''}` },
        h('span', { class: 'stat-label' }, `STAI-6 #${i + 1}`),
        h('span', { class: 'stat-value' }, v == null ? 'incomplete' : fmtNum(v)),
        h('span', { class: 'stat-sub' }, v == null ? (r && r.reached ? `${answered}/6 answered` : 'not reached') : 'range 20–80'));
    };
    const derived = (label, v, sub, suffix = '') => h('div', { class: `stat${v == null ? ' is-missing' : ''}` },
      h('span', { class: 'stat-label' }, label),
      h('span', { class: 'stat-value' }, v == null ? 'n/a' : `${suffix ? '' : sign(v)}${fmtNum(v)}${suffix}`),
      h('span', { class: 'stat-sub' }, sub));

    const taskRows = S.taskOrder.map((id, i) => {
      const t = CFG.tasks[id], r = S.tasks[id] || {};
      let result;
      if (!r.reached) result = h('span', { class: 'muted' }, 'not reached');
      else if (t.kind === 'serial') result = [pill('Correct', r.correct, 'good'), pill('Wrong', r.wrong, 'bad')];
      else if (t.kind === 'stroop') result = [pill('Correct', r.correct, 'good'), pill('Wrong', r.wrong, 'bad'), pill('Missed', r.missed, 'warn')];
      else if (t.kind === 'reading') result = h('span', { class: 'muted' }, `Passage ${r.passage} shown`);
      else result = h('span', { class: 'muted' }, 'Spoken task (no scored responses)');
      if (r.reached && r.skipped) result = [].concat(result, h('span', { class: 'pill pill-warn' }, 'Skipped'));
      return h('tr', { class: S.mostStressful === id ? 'is-picked' : '' },
        h('td', { class: 'num' }, String(i + 1)),
        h('td', null, h('span', { class: 'cell-task', style: `--task:${t.accent}`, html: `${ICON[t.icon] || ''}<span><strong>${t.label}</strong><small>${t.title}</small></span>` })),
        h('td', null, h('div', { class: 'pills' }, result)));
    });
    function pill(label, v, tone) { return h('span', { class: `pill pill-${tone}` }, h('b', null, String(v ?? 0)), ` ${label}`); }

    const picked = S.mostStressful ? CFG.tasks[S.mostStressful] : null;

    const saveEl = h('div', { class: 'notice' });
    const paintSave = () => {
      if (!saveEl.isConnected && saveEl.dataset.painted) return;
      saveEl.dataset.painted = '1';
      const st = (S && S.save && S.save.state) || 'off';
      const [icon, msg] = {
        sending: [ICON.clock, '<strong>Saving to Google Sheet…</strong> Please keep this page open.'],
        sent: [ICON.check, '<strong>Sent to Google Sheet.</strong> The STAI-6 responses were delivered.'],
        failed: [ICON.alert, '<strong>Could not reach Google Sheet.</strong> The rows are kept in this browser and retried next time this page loads online. Write the results down now.'],
        test: [ICON.alert, '<strong>Test mode: nothing was sent.</strong> Sessions with testSpeed other than 1 are never saved.'],
        off: [ICON.alert, '<strong>Saving is off.</strong> Set saving.enabled and saving.url in config.js.'],
      }[st];
      saveEl.innerHTML = `${icon}<span>${msg}</span>`;
    };
    DataSink.listener = paintSave;
    paintSave();
    const timeline = S.events.filter((e) => ['phase', 'task-part', 'skip', 'pause', 'resume', 'end'].includes(e.type));

    const newBtn = h('button', { class: 'btn btn-primary btn-lg', html: `${ICON.refresh}<span>New session</span>`, onClick: async () => {
      if (await confirmDialog({ title: 'Start a new session?', body: 'The results on this screen will be cleared.', confirmText: 'New session' })) { S = null; renderSetup(); }
    } });
    const outBtn = h('button', { class: 'btn btn-ghost btn-lg', html: `${ICON.logout}<span>Log out</span>`, onClick: async () => {
      if (await confirmDialog({ title: 'Log out?', body: 'The results on this screen will be cleared.', confirmText: 'Log out' })) { S = null; Music.statusListener = null; renderLogin(); }
    } });

    const condLabel = S.condition === 'music' ? 'Music' : 'Quiet rest' + (S.nature ? ` (${S.nature.played} of ${S.nature.planned.length} nature cues played)` : '');
    const musicInfo = S.condition === 'music'
      ? (!S.music || !S.music.source ? 'no music source set'
        : S.music.error ? `error: ${S.music.error}`
        : `${S.music.source === 'youtube' ? 'YouTube' : 'audio file'}${S.music.blocked ? ', autoplay was blocked (tap fallback shown)' : ''}`)
      : null;

    showScreen(h('section', { class: 'screen screen-end' },
      h('div', { class: 'end-wrap' },
        h('div', { class: 'end-hero' },
          h('div', { class: 'end-check', html: S.aborted ? ICON.flag : ICON.check }),
          h('div', null,
            h('h1', null, S.aborted ? 'Session ended' : 'Session complete'),
            h('p', { class: 'muted' }, S.aborted ? 'The session was ended early by the researcher.' : 'Thank you. Please stay seated, the researcher will be with you in a moment.'))),

        h('div', { class: 'card end-card' },
          h('div', { class: 'section-head' }, h('h3', null, 'STAI-6 results'), h('span', { class: 'tiny muted' }, 'Researcher view')),
          h('div', { class: 'stats stats-3' }, S.stai.map(staiCard)),
          h('div', { class: 'stats stats-3' },
            derived('Reactivity', reactivity, 'STAI2 − STAI1'),
            derived('Recovery score', recovery, 'STAI2 − STAI3'),
            derived('Recovery', pct, '(STAI2 − STAI3) ÷ (STAI2 − STAI1)', '%'))),

        h('div', { class: 'card end-card' },
          h('div', { class: 'section-head' }, h('h3', null, 'Stress tasks, in the order performed'),
            h('span', { class: 'tiny muted' }, picked ? 'Highlighted: picked as most stressful' : '')),
          h('table', { class: 'task-table' },
            h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Task'), h('th', null, 'Results'))),
            h('tbody', null, taskRows)),
          h('div', { class: 'picked' },
            h('span', { class: 'muted' }, 'Most stressful (participant):'),
            picked ? h('strong', { class: 'cell-task', style: `--task:${picked.accent}`, html: `${ICON[picked.icon] || ''}<span>${picked.label}: ${picked.title}</span>` }) : h('strong', null, 'No answer'))),

        h('details', { class: 'card end-card details' },
          h('summary', null, 'Session details and phase timeline'),
          h('dl', { class: 'meta' },
            h('dt', null, 'Participant / week'), h('dd', null, `${S.participantId || '–'} · ${S.week || '–'}`),
            h('dt', null, 'Session ID'), h('dd', null, S.id),
            h('dt', null, 'Recovery condition'), h('dd', null, condLabel + (musicInfo ? ` (${musicInfo})` : '')),
            h('dt', null, 'Started / ended'), h('dd', null, `${fmtTime(S.startedAt)} / ${fmtTime(S.endedAt)}`),
            SPEED !== 1 ? [h('dt', null, 'Test speed'), h('dd', null, `${SPEED}× (not a real session)`)] : null),
          h('table', { class: 'timeline' },
            h('thead', null, h('tr', null, h('th', null, 'Clock time'), h('th', null, 'Session time'), h('th', null, 'Event'))),
            h('tbody', null, timeline.map((e) => h('tr', null,
              h('td', null, fmtTime(e.wall)),
              h('td', { class: 'num' }, `${(e.sessionMs / 1000).toFixed(1)} s`),
              h('td', null, e.type === 'phase' ? e.label : e.type === 'pause' ? 'Paused' : e.type === 'resume' ? 'Resumed' : e.label)))))),

        saveEl,
        h('div', { class: 'end-actions' }, newBtn, outBtn))));
  }

  /* =========================================================================
     12. GLOBAL KEYBOARD, FULLSCREEN, IDLE CURSOR, BOOT
     ========================================================================= */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (dialogOpen) { e.preventDefault(); dialogOpen.close(false); return; }
      if (running) { e.preventDefault(); if (Clock.paused) resumeSession(false); else pauseSession('Esc'); }
      return;
    }
    if (!running || Clock.paused || dialogOpen) return;
    const c = Runner.cur;
    if (c && c.onKey) c.onKey(e);
  });

  // If fullscreen is left (e.g. Esc where keyboard lock is unsupported), pause.
  const onFsChange = () => { if (running && !Clock.paused && !isFullscreen()) pauseSession('fullscreen'); };
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('webkitfullscreenchange', onFsChange);

  // Hide the mouse cursor after a few idle seconds during the session.
  let idleTimer = null;
  document.addEventListener('pointermove', () => {
    document.body.classList.remove('cursor-idle');
    clearTimeout(idleTimer);
    if (running) idleTimer = setTimeout(() => { if (running && !Clock.paused) document.body.classList.add('cursor-idle'); }, 3000);
  });

  // Warn before closing the tab mid-session.
  window.addEventListener('beforeunload', (e) => { if (running) { e.preventDefault(); e.returnValue = ''; } });

  if (SPEED !== 1) {
    const b = $('#test-badge');
    b.hidden = false;
    b.textContent = `TEST MODE · phases ${SPEED}× faster`;
  }

  document.title = CFG.appTitle;
  renderLogin();
  DataSink.flush().catch(() => {});   // retry rows left over from an offline session

  // Small debugging handle for the browser console (read-only use).
  window.__session = { get record() { return S; }, Clock, Runner, Music };
})();

/* =============================================================================
   SESSION CONFIGURATION
   -----------------------------------------------------------------------------
   Every timing, the login, the music source and all task content live here.
   Edit values in this file only; app.js reads everything from APP_CONFIG.
   All durations are in SECONDS unless the name says otherwise.
   ============================================================================= */
window.APP_CONFIG = {

  appTitle: 'Stress & Recovery Session',

  /* ---- 1. Login (plain constants; username is case-insensitive) ---------- */
  auth: {
    username: 'admin',
    password: 'admin123',
  },

  /* ---- 2. Timeline ------------------------------------------------------- */
  timing: {
    baselineSeconds: 300,        // 1. Baseline rest
    staiSeconds: 120,            // 2/4/6. Time allowed for each STAI-6
    taskInstructionSeconds: 12,  // Instruction card before each stress task
    taskSeconds: 60,             // Each stress task runs exactly this long
    recoverySeconds: 600,        // 5. Recovery: 10 min, same for the Music group and the Quiet-rest group
    finalQuestionSeconds: 60,    // 7. Time allowed for the final question
    staiAutoAdvanceMs: 450,      // Pause after an answer before the next STAI item (ms)
  },

  /* Testing aid: divides every PHASE duration above (not the in-task timings
     such as the 2.5 s Stroop window). 1 = real session. e.g. 10 = run a whole
     session in about 2 minutes. A warning badge shows whenever this is not 1. */
  testSpeed: 1,

  /* ---- Skip button on instruction cards and tasks ------------------------
     true = a small "Skip" button appears bottom-right on every task screen. */
  allowSkip: true,

  /* ---- Saving to Google Sheets (Apps Script web app) ----------------------
     At the end of each session the app POSTs: one row per STAI-6 (STAI_Responses tab),
     one session summary (Session_Summary tab) and one row per phase/task (Task_Log tab).
     Sessions run with testSpeed != 1 are never sent. */
  saving: {
    enabled: true,
    // Saved: STAI_Responses (one row per STAI, 3 per session) and
    //        Session_Summary (one row per session: STAI totals, reactivity, recovery).
    summary: true,   // Session_Summary tab
    taskLog: false,  // Task_Log tab (one row per task / rest phase), off = task data is not saved
    url: 'https://script.google.com/macros/s/AKfycbxPmYTvpuG3J0-khKRyWjH7bwKT5KTQyZpyZjU46njsPibXuI48SSN6RNnkAr2QFa0f/exec',
  },

  /* ---- 2b. Participant setup: weeks and group names ---------------------
     The researcher picks the participant ID, group and week on the first page.
     The week label is saved in the "Session" column, the group label in "Group". */
  weeks: [
    'Week 0 (baseline)',
    'Week 1',
    'Week 2',
    'Week 3',
    'Week 4',
    'Follow-up Week 5',
  ],
  groupLabels: { music: 'A - Music', quiet: 'B - Quiet' },

  /* ---- 3. Recovery music (Music condition only) -------------------------- */
  music: {
    // Option A: a YouTube video ID, e.g. for https://www.youtube.com/watch?v=XXXXXXXXXXX
    // put 'XXXXXXXXXXX' here.
    youtubeVideoId: '',
    youtubeStartSeconds: 0,      // Start offset into the YouTube video

    // Option B (used by default): a LOCAL audio file served with the site.
    // >>> AUDIO LOCATION: put your file in the /audio folder of the project and
    // >>> write its path here, e.g. 'audio/recovery.mp3' (or .m4a / .wav / .ogg).
    // It autoplays when recovery starts (the researcher's Start click unlocks
    // audio) and loops if the track is shorter than the recovery phase.
    audioFile: 'audio/Music.mp3',

    // If both are set, which one to use first: 'youtube' or 'file'.
    // If the preferred source fails to load, the other one is used.
    prefer: 'file',

    volume: 70,                  // 0 to 100
    fadeInSeconds: 1,            // Gentle fade-in at the start of recovery (0 = none)
    fadeOutSeconds: 3,           // Fade-out that ends exactly when recovery ends
    autoplayCheckSeconds: 2,     // Show "Tap to start the music" if not playing after this
  },

  /* ---- 3b. Nature-sound cues (Quiet group only) ---------------------------
     During the quiet recovery, a short natural sound plays a few times at
     random moments, to keep the participant from getting sleepy.
     >>> Put your 30-second file(s) in the /audio folder, e.g. audio/nature.mp3.
     If you list several files, a random one is used for each cue. */
  natureCues: {
    enabled: true,
    files: ['audio/nature.mp3'],
    count: 3,                    // How many times it plays in the 10-minute recovery phase
    seconds: 30,                 // Length of each cue (a longer file is cut here, a shorter one loops)
    marginSeconds: 60,           // No cue in the first / last N seconds of recovery
    volume: 60,                  // 0 to 100
    fadeInSeconds: 2,
    fadeOutSeconds: 3,
  },

  /* ---- 4. Rest screen wording ------------------------------------------- */
  text: {
    baseline: {
      eyebrow: 'Resting baseline',
      title: 'Sit back and rest',
      lines: ['Sit comfortably and stay still', 'Keep your eyes open', 'Breathe normally'],
    },
    recoveryQuiet: {
      eyebrow: 'Recovery',
      title: 'Time to recover',
      lines: ['Sit comfortably and stay still', 'Keep your eyes open', 'Breathe normally and let yourself relax'],
    },
    recoveryMusic: {
      eyebrow: 'Recovery',
      title: 'Relax and listen',
      lines: ['Sit comfortably and stay still', 'Keep your eyes open', 'Breathe normally and enjoy the music'],
    },
  },

  /* ---- 5. STAI-6 ---------------------------------------------------------- */
  stai: {
    prompt: 'How much does this describe you right now, at this moment?',
    // reverse: true -> reverse-scored (1=4, 2=3, 3=2, 4=1)
    items: [
      { text: 'I feel calm',    reverse: true  },
      { text: 'I am tense',     reverse: false },
      { text: 'I feel upset',   reverse: false },
      { text: 'I am relaxed',   reverse: true  },
      { text: 'I feel content', reverse: true  },
      { text: 'I am worried',   reverse: false },
    ],
    options: [
      { value: 1, label: 'Not at all' },
      { value: 2, label: 'Somewhat' },
      { value: 3, label: 'Moderately' },
      { value: 4, label: 'Very much' },
    ],
    // Total = sum of the six item scores x scaleFactor (gives a 20 to 80 range).
    scaleFactor: 20 / 6,
  },

  /* ---- 6. The stress tasks ------------------------------------------------
     kind: 'serial' | 'stroop' | 'speaking' | 'reading'
     accent: colour used for this task's card, chip and background glow
     icon:   calculator | pulse | palette | speech | book
     In rules, {name} is replaced with that value from the task, e.g. {start},
     {step}, {trialSeconds}, {readSeconds}; also {taskSeconds} and
     {explainSeconds} (taskSeconds minus readSeconds).                        */
  tasks: {
    A: {
      kind: 'serial', icon: 'calculator', accent: '#8ea2ff',
      label: 'Mental arithmetic',
      title: 'Count backwards by 7',
      start: 1011, step: 7,
      rules: [
        'Start at {start} and keep subtracting {step}.',
        'Type the next number and press Enter.',
        'If an answer is wrong you will see an error. Just try again.',
        'Go as fast as you can.',
      ],
    },
    B: {
      kind: 'serial', icon: 'pulse', accent: '#45c7b4',
      label: 'Arithmetic + tapping',
      title: 'Count backwards by 3 and tap',
      start: 1152, step: 3,
      pulseBpm: 60,              // Visual beat for the tapping hand
      rules: [
        'Start at {start} and keep subtracting {step}. Type each answer and press Enter.',
        'At the same time, tap the beat of the pulsing circle with your free hand.',
        'Keep the hand wearing the sensor still.',
      ],
    },
    C: {
      kind: 'stroop', icon: 'palette', accent: '#c7a2ff',
      label: 'Colour and word',
      title: 'Name the ink colour',
      trialSeconds: 2.5,         // Each word disappears after this
      incongruentRatio: 0.8,     // Share of trials where word and ink differ
      blockSize: 10,             // Ratio is exact within each block of this many trials
      feedbackMs: 450,           // Feedback shown before the next word
      colors: [
        { name: 'Red',    key: 'R', hex: '#ff5d5d' },
        { name: 'Blue',   key: 'B', hex: '#4f8dff' },
        { name: 'Green',  key: 'G', hex: '#3fcf74' },
        { name: 'Yellow', key: 'Y', hex: '#ffd23f' },
      ],
      rules: [
        'A colour word appears, written in a coloured ink.',
        'Choose the colour of the INK, not what the word says.',
        'Click the colour, or press R, B, G or Y.',
        'Each word disappears after {trialSeconds} seconds.',
      ],
    },
    D: {
      kind: 'speaking', icon: 'speech', accent: '#f3b562',
      label: 'Speaking',
      title: 'Job interview',
      prompt: 'Tell the interviewer about your strengths, and about your weaknesses.',
      subPrompt: 'Speak out loud and keep going until the time is up.',
      rules: [
        'Imagine you are in a real job interview.',
        'Talk about your strengths and your weaknesses.',
        'Speak out loud and keep going for the whole minute.',
        'Sit still while you speak.',
      ],
    },
    E: {
      kind: 'reading', icon: 'book', accent: '#f28fae',
      label: 'Reading and explaining',
      title: 'Read, then explain',
      readSeconds: 30,           // Passage disappears after this; the rest is explaining
      explainPrompt: 'Now explain out loud, in your own words, what the passage said and what you think about it.',
      rules: [
        'Part 1 (first {readSeconds} seconds): read the passage. It then disappears.',
        'Part 2 (last {explainSeconds} seconds): explain out loud, in your own words, what it said and what you think.',
      ],
      // One passage is picked at random each session.
      passages: [
        'Most of the world\'s trade by volume travels by sea, and a large share of it squeezes through a few narrow passages, such as the Strait of Malacca, the Suez Canal, the Strait of Hormuz and the Panama Canal. When one of them is blocked, ships must take detours of thousands of kilometres, insurance costs climb, and prices rise in countries far from the crisis. Governments respond by building alternative routes, holding larger stockpiles and strengthening naval presence, yet every workaround creates new dependencies. A disruption that begins in one strait can therefore become a problem for farmers, factories and families everywhere.',
        'As Arctic ice thins, shipping lanes north of Russia and Canada stay open for longer each summer, shortening the voyage between East Asia and Europe by thousands of kilometres. The prospect has drawn the attention of several governments, which are expanding ports, icebreaker fleets and military activity in the region. Yet these waters are poorly charted, far from rescue services, and home to fragile ecosystems and Indigenous communities, so a single accident could cause lasting harm. Who should set the rules for a route that is only now becoming usable, and whose interests should come first?',
      ],
    },
  },

  /* Task order is random each session. Pairs listed here are never placed
     back to back (by task key). */
  neverAdjacent: [['D', 'E']],

  /* ---- 7. Final question -------------------------------------------------- */
  finalQuestion: {
    prompt: 'Which task felt the most stressful?',
  },
};

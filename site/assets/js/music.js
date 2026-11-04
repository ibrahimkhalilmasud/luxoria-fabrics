/* Lounge music that carries on from page to page, with a floating player (play/pause, next track).
   The track and position are kept for the visit; each new page picks up where the last one stopped.
   When a browser blocks sound on a fresh page, it resumes on the visitor's first tap or key press. */

const TRACKS = [
  { src: "audio/lounge.m4a", title: "Salon No. 1" },
  { src: "audio/lounge-2.m4a", title: "Salon No. 2" },
];
const PREF_KEY = "luxoria.sound";  // "on" | "off", remembered between visits
const STATE_KEY = "luxoria.music"; // { track, time, playing } for this visit
const SAVE_EVERY_MS = 1000;
const TOAST_MS = 2600;
const FADE_STEP_MS = 50;
const RESUME_EVENTS = ["pointerdown", "pointerup", "touchend", "keydown", "click"];

const store = (area) => ({
  get(k) { try { return area().getItem(k); } catch { return null; } },
  set(k, v) { try { area().setItem(k, v); } catch { /* private mode: nothing is remembered */ } },
});
const local = store(() => localStorage);
const session = store(() => sessionStorage);

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5h3v14h-3zM13.5 5h3v14h-3z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 5.5v13l9-6.5zM16 5.5h2.5v13H16z" fill="currentColor"/></svg>',
};

const m = { audio: null, track: 0, playing: false, waiting: false, el: null, lastSave: 0, fadeTimer: 0 };

function readState() {
  try {
    const s = JSON.parse(session.get(STATE_KEY) || "null");
    if (!s || typeof s !== "object") return null;
    const track = Number.isInteger(s.track) && s.track >= 0 && s.track < TRACKS.length ? s.track : 0;
    const time = Number.isFinite(s.time) && s.time > 0 ? s.time : 0;
    return { track, time, playing: s.playing === true };
  } catch {
    return null;
  }
}

function saveState(force = false) {
  const now = Date.now();
  if (!force && now - m.lastSave < SAVE_EVERY_MS) return;
  m.lastSave = now;
  session.set(STATE_KEY, JSON.stringify({ track: m.track, time: m.audio?.currentTime || 0, playing: m.playing || m.waiting }));
}

/* ---------- Audio ---------- */
function load(track, time = 0) {
  if (!m.audio) {
    m.audio = new Audio();
    m.audio.preload = "auto";
    m.audio.addEventListener("timeupdate", () => saveState());
    m.audio.addEventListener("ended", () => next({ announce: true }));
  }
  m.track = track;
  m.audio.src = TRACKS[track].src;
  if (time > 0) m.audio.addEventListener("loadedmetadata", () => { m.audio.currentTime = Math.min(time, m.audio.duration - 1 || time); }, { once: true });
}

// Fades with element volume. Some phones ignore volume; there the music simply starts.
// A timer, not animation frames: frames stop in hidden tabs and would leave the music silent.
function fadeTo(target, seconds, done) {
  clearInterval(m.fadeTimer);
  const from = m.audio.volume;
  const start = Date.now();
  m.fadeTimer = setInterval(() => {
    const k = Math.min(1, (Date.now() - start) / (seconds * 1000));
    m.audio.volume = Math.min(1, Math.max(0, from + (target - from) * k));
    if (k < 1) return;
    clearInterval(m.fadeTimer);
    done?.();
  }, FADE_STEP_MS);
}

function attemptPlay(fadeSeconds) {
  m.audio.volume = 0;
  return m.audio.play().then(() => {
    m.playing = true;
    m.waiting = false;
    stopWaiting();
    fadeTo(1, fadeSeconds);
    render();
    saveState(true);
  });
}

function onResumeGesture() {
  if (!m.waiting) return stopWaiting();
  attemptPlay(1.2).catch(() => { /* still blocked: wait for the next tap */ });
}

function waitForGesture() {
  m.waiting = true;
  RESUME_EVENTS.forEach((e) => document.addEventListener(e, onResumeGesture, { capture: true, passive: true }));
  render();
}

function stopWaiting() {
  RESUME_EVENTS.forEach((e) => document.removeEventListener(e, onResumeGesture, { capture: true }));
}

/** Starts the music. Call it inside a tap or click so browsers allow sound. */
export function playMusic({ fadeSeconds = 1.2, announce = false } = {}) {
  if (!m.audio) load(m.track);
  local.set(PREF_KEY, "on");
  attemptPlay(fadeSeconds).then(() => { if (announce) toast(`Now playing · ${TRACKS[m.track].title}`); })
    .catch(() => { m.playing = false; render(); });
}

export function pauseMusic() {
  local.set(PREF_KEY, "off");
  m.playing = false;
  m.waiting = false;
  stopWaiting();
  render();
  saveState(true);
  if (!m.audio) return;
  fadeTo(0, 0.6, () => { if (!m.playing) m.audio.pause(); });
}

function next({ announce = false } = {}) {
  load((m.track + 1) % TRACKS.length);
  playMusic({ fadeSeconds: 0.8, announce });
}

export const musicAllowed = () => local.get(PREF_KEY) !== "off";

/* ---------- Player ---------- */
function render() {
  if (!m.el) return;
  const on = m.playing;
  m.el.classList.toggle("is-on", on);
  m.el.classList.toggle("is-waiting", m.waiting);
  const toggle = m.el.querySelector(".player__toggle");
  toggle.innerHTML = on ? ICONS.pause : ICONS.play;
  toggle.setAttribute("aria-label", on ? "Pause music" : "Play music");
  toggle.setAttribute("aria-pressed", String(on));
  m.el.querySelector(".player__title").textContent = m.waiting ? "Tap to continue" : TRACKS[m.track].title;
}

/** A small message that springs out of the player. */
function toast(text) {
  if (!m.el) return;
  const t = m.el.querySelector(".player__toast");
  t.textContent = text;
  t.classList.remove("is-on");
  void t.offsetWidth;
  t.classList.add("is-on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("is-on"), TOAST_MS);
}

function mountPlayer() {
  const el = document.createElement("div");
  el.className = "player";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "Background music");
  el.innerHTML = `
    <span class="player__toast" role="status" aria-live="polite"></span>
    <span class="player__bars" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
    <span class="player__title"></span>
    <button class="player__btn player__toggle" type="button"></button>
    <button class="player__btn player__next" type="button" aria-label="Next track">${ICONS.next}</button>`;
  el.querySelector(".player__toggle").addEventListener("click", (e) => {
    e.stopPropagation();
    if (m.playing) { pauseMusic(); toast("Music paused"); } else playMusic({ announce: true });
  });
  el.querySelector(".player__next").addEventListener("click", (e) => { e.stopPropagation(); next({ announce: true }); });
  document.body.append(el);
  m.el = el;
  render();
}

export function showPlayer({ announce = false } = {}) {
  m.el?.classList.add("is-shown");
  if (announce && m.playing) setTimeout(() => toast(`Now playing · ${TRACKS[m.track].title}`), 400);
}

/** Mounts the player on every page and carries on the music from the previous page. */
export function initMusic() {
  if (m.el) return;
  const state = readState();
  if (state) m.track = state.track;
  mountPlayer();
  if (!document.body.classList.contains("has-door")) showPlayer();

  window.addEventListener("pagehide", () => saveState(true));
  document.addEventListener("visibilitychange", () => {
    if (!m.audio || !m.playing) return;
    if (document.hidden) { saveState(true); m.audio.pause(); } else m.audio.play().catch(() => {});
  });

  if (!state?.playing || !musicAllowed()) return;
  load(state.track, state.time);
  attemptPlay(1.5).catch(waitForGesture);
}

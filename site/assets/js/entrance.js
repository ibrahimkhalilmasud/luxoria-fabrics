/* The front door: two etched glass doors over a model photograph. A touch opens them in a
   burst of warm light and starts soft lounge music. Shown once per visit, never on deep links. */
import { $, lockScroll } from "./core.js";
import { musicAllowed, playMusic, showPlayer } from "./music.js";

const SEEN_KEY = "luxoria.entered";
const OPEN_MS = 2300;

const session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* private mode: the door shows again next time */ } },
};
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- Door ---------- */
const ETCH = `<g fill="none" stroke="rgba(230,207,154,.55)" stroke-width="1">
  <path d="M20 40 Q100 -10 180 40"/><path d="M34 52 Q100 10 166 52"/>
  ${Array.from({ length: 9 }, (_, i) => `<line x1="100" y1="300" x2="${20 + i * 20}" y2="70"/>`).join("")}
  <circle cx="100" cy="300" r="46"/><circle cx="100" cy="300" r="30"/>
  <path d="M100 254 L104 292 L100 300 L96 292 Z" fill="rgba(230,207,154,.5)"/>
  ${Array.from({ length: 6 }, (_, i) => `<path d="M20 ${430 + i * 22} H180" stroke-opacity="${(0.5 - i * 0.07).toFixed(2)}"/>`).join("")}
  <path d="M20 560 Q100 520 180 560"/></g>`;

function leafSvg(side) {
  const handleX = side === "l" ? 186 : 6;
  return `<svg viewBox="0 0 200 600" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="glass-${side}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fff" stop-opacity=".18"/><stop offset=".45" stop-color="#fff" stop-opacity=".04"/>
        <stop offset=".55" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/>
      </linearGradient>
      <linearGradient id="gold-${side}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#e6cf9a"/><stop offset=".5" stop-color="#a37e2c"/><stop offset="1" stop-color="#e6cf9a"/>
      </linearGradient>
    </defs>
    <rect x="2" y="2" width="196" height="596" fill="url(#glass-${side})" stroke="url(#gold-${side})" stroke-width="4"/>
    <rect x="14" y="14" width="172" height="572" fill="none" stroke="rgba(230,207,154,.4)" stroke-width="1"/>
    ${ETCH}
    <rect x="${handleX}" y="250" width="8" height="120" rx="4" fill="url(#gold-${side})" class="door__handle"/>
  </svg>`;
}

function buildDoor() {
  const el = document.createElement("div");
  el.className = "door";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Welcome to Luxoria");
  el.innerHTML = `
    <div class="door__scene" aria-hidden="true"></div>
    <div class="door__light" aria-hidden="true"></div>
    <div class="door__frame" aria-hidden="true">
      <div class="door__leaf door__leaf--l">${leafSvg("l")}</div>
      <div class="door__leaf door__leaf--r">${leafSvg("r")}</div>
    </div>
    <div class="door__flash" aria-hidden="true"></div>
    <button class="door__enter" type="button">
      <span class="door__crest" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M20 3 L23 13 L33 9 L28 18 L37 20 L28 22 L33 31 L23 27 L20 37 L17 27 L7 31 L12 22 L3 20 L12 18 L7 9 L17 13 Z" fill="none" stroke="currentColor" stroke-width="1"/><circle cx="20" cy="20" r="3.2" fill="currentColor"/></svg></span>
      <span class="door__word">LUXORIA</span>
      <span class="door__tag">Couture Fabrics · Private Showroom</span>
      <span class="door__touch"><i aria-hidden="true"></i>Touch the door to enter</span>
    </button>
    <p class="door__hint">Soft music plays inside — switch it off any time.</p>`;
  return el;
}

function open(door) {
  if (door.classList.contains("is-opening")) return;
  // Start the music synchronously in the same tap, before any timers.
  if (musicAllowed()) playMusic({ fadeSeconds: 4 });
  session.set(SEEN_KEY, "1");
  door.classList.add("is-opening");
  navigator.vibrate?.(12);
  setTimeout(() => {
    door.remove();
    lockScroll(false);
    document.body.classList.remove("has-door");
    showPlayer({ announce: true });
  }, reducedMotion() ? 500 : OPEN_MS);
}

/** Photo behind the glass: one of the best model photographs, different on each visit. */
async function scenePhoto() {
  try {
    const res = await fetch("data/lookbook.json", { cache: "no-cache" });
    const { looks } = await res.json();
    const best = [...looks].sort((a, b) => b.score - a.score).slice(0, 8);
    return best[Math.floor(Math.random() * best.length)]?.photos[0]?.src || "";
  } catch {
    return "";
  }
}

export async function initEntrance() {
  const deepLink = location.hash.length > 1 || location.search.length > 1;
  if (deepLink || session.get(SEEN_KEY)) return;
  const door = buildDoor();
  document.body.classList.add("has-door");
  document.body.append(door);
  lockScroll(true);
  const enter = $(".door__enter", door);
  enter.focus({ preventScroll: true });
  door.addEventListener("click", () => open(door));
  door.addEventListener("keydown", (e) => {
    if (e.key === "Escape") open(door);
    if (e.key === "Tab") { e.preventDefault(); enter.focus(); }
  });
  const photo = await scenePhoto();
  if (!photo) return;
  const img = new Image();
  img.onload = () => {
    $(".door__scene", door).style.backgroundImage = `url('${photo}')`;
    door.classList.add("has-scene");
  };
  img.src = photo;
}

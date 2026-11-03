/* Full-screen fabric viewer: whole photo, swipe between pieces, pinch / double-tap zoom,
   details sheet and add-to-cart. Shared by the home, showroom and cart pages. */
import { $, cart, CFG, esc, ICON_CHECK, ICON_PLUS, lockScroll, productUrl, qtyText, seriesText, specsOf, titleOf, toast, toggleCart, whatsappHref, mailHref } from "./core.js";

const MAX_ZOOM = 4;
const TAP_ZOOM = 2.6;
const SWIPE_PX = 60;
const CLOSE_SWIPE_PX = 120;

let root = null;
let state = { list: [], index: 0, onIndex: null, syncHash: false };
let view = { scale: 1, x: 0, y: 0 };
let lastFocus = null;

function build() {
  root = document.createElement("div");
  root.className = "fv";
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-modal", "true");
  root.setAttribute("aria-label", "Fabric viewer");
  root.innerHTML = `
    <div class="fv__top">
      <span class="fv__count" aria-live="polite"></span>
      <button class="fv__icon" data-fv="close" aria-label="Close viewer">✕</button>
    </div>
    <div class="fv__stage"><img class="fv__img" alt="" draggable="false"></div>
    <button class="fv__icon fv__nav fv__nav--prev" data-fv="prev" aria-label="Previous fabric">‹</button>
    <button class="fv__icon fv__nav fv__nav--next" data-fv="next" aria-label="Next fabric">›</button>
    <p class="fv__hint">Double-tap or click to zoom · swipe for the next piece</p>
    <div class="fv__bar">
      <div class="fv__title">
        <h3></h3>
        <p></p>
      </div>
      <div class="fv__actions">
        <button class="fv__details" data-fv="details" aria-expanded="false">Details</button>
        <button class="btn btn--gold fv__cart" data-fv="cart"></button>
      </div>
    </div>
    <section class="fv__sheet" aria-label="Fabric details">
      <dl class="specs"></dl>
      <div class="palette"></div>
      <div class="fv__sheet-actions">
        <a class="btn btn--line" data-fv="enquire" target="_blank" rel="noopener">Ask about this piece</a>
        <button class="link" data-fv="share">Copy link to this fabric</button>
      </div>
    </section>`;
  document.body.append(root);

  root.addEventListener("click", onClick);
  document.addEventListener("keydown", onKey);
  initGestures($(".fv__stage", root));
  cart.onChange(renderCartButton);
}

function onClick(e) {
  const action = e.target.closest("[data-fv]")?.dataset.fv;
  if (!action) return;
  if (action === "close") close();
  if (action === "prev") step(-1);
  if (action === "next") step(1);
  if (action === "cart") toggleCart(current());
  if (action === "details") toggleSheet();
  if (action === "share") share();
}

function onKey(e) {
  if (!root || root.hidden) return;
  if (e.key === "Escape") close();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
  else if (e.key === "+" || e.key === "=") setZoom(Math.min(MAX_ZOOM, view.scale * 1.5));
  else if (e.key === "-") setZoom(Math.max(1, view.scale / 1.5));
}

const current = () => state.list[state.index];

export function openViewer(list, index, opts = {}) {
  if (!list.length) return;
  if (!root) build();
  state = { list, index: Math.max(0, Math.min(index, list.length - 1)), onIndex: opts.onIndex || null, syncHash: !!opts.syncHash };
  lastFocus = document.activeElement;
  root.hidden = false;
  root.classList.remove("is-sheet");
  lockScroll(true);
  render();
  $('[data-fv="close"]', root).focus({ preventScroll: true });
}

export function close() {
  if (!root || root.hidden) return;
  root.hidden = true;
  lockScroll(false);
  if (state.syncHash && location.hash.startsWith("#fabric/")) {
    history.replaceState(null, "", location.pathname + location.search);
  }
  lastFocus?.focus?.({ preventScroll: true });
}

function step(dir) {
  if (state.list.length < 2) return;
  state.index = (state.index + dir + state.list.length) % state.list.length;
  render(dir);
  state.onIndex?.(state.index);
}

function render(dir = 0) {
  const p = current();
  const img = $(".fv__img", root);
  resetZoom();
  img.classList.remove("is-in-left", "is-in-right");
  img.classList.add("is-loading");
  img.onload = () => {
    img.classList.remove("is-loading");
    if (dir) img.classList.add(dir > 0 ? "is-in-right" : "is-in-left");
  };
  img.src = p.image;
  img.alt = `${titleOf(p)} — ${p.colourFamily || ""} ${p.category || ""}`.trim();

  $(".fv__count", root).textContent = `${state.index + 1} / ${state.list.length}`;
  $(".fv__title h3", root).textContent = titleOf(p);
  $(".fv__title p", root).textContent = [p.category, seriesText(p), p.composition, qtyText(p.quantity)].filter(Boolean).join(" · ");
  $(".specs", root).innerHTML = specsOf(p).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  $(".palette", root).innerHTML = (p.palette || []).map((c) => `<span style="--c:${esc(c)}" title="${esc(c)}"></span>`).join("");

  const text = `Hello ${CFG.brand}, I am interested in ${titleOf(p)}${p.designNo ? ` (${seriesText(p)})` : ""} — ${qtyText(p.quantity)} — ${productUrl(p.id)}`;
  const enquire = $('[data-fv="enquire"]', root);
  enquire.hidden = !CFG.whatsapp && !CFG.email;
  enquire.href = CFG.whatsapp ? whatsappHref(text) : mailHref(`Enquiry — ${titleOf(p)}`, text);

  const many = state.list.length > 1;
  $(".fv__nav--prev", root).hidden = !many;
  $(".fv__nav--next", root).hidden = !many;
  renderCartButton();
  preload(state.index + 1);
  preload(state.index - 1);
  if (state.syncHash) history.replaceState(null, "", `${location.pathname}${location.search}#fabric/${encodeURIComponent(p.id)}`);
}

function renderCartButton() {
  if (!root || root.hidden) return;
  const p = current();
  const on = cart.has(p.id);
  const btn = $(".fv__cart", root);
  btn.classList.toggle("is-on", on);
  btn.innerHTML = on ? `${ICON_CHECK}<span>In cart</span>` : `${ICON_PLUS}<span>Add to cart</span>`;
  btn.setAttribute("aria-pressed", String(on));
}

function preload(i) {
  const p = state.list[(i + state.list.length) % state.list.length];
  if (p) new Image().src = p.image;
}

function toggleSheet() {
  const open = root.classList.toggle("is-sheet");
  $('[data-fv="details"]', root).setAttribute("aria-expanded", String(open));
  $('[data-fv="details"]', root).textContent = open ? "Hide details" : "Details";
}

async function share() {
  const url = productUrl(current().id);
  try {
    if (navigator.share && matchMedia("(pointer: coarse)").matches) {
      await navigator.share({ title: titleOf(current()), url });
      return;
    }
    await navigator.clipboard.writeText(url);
    toast("Link copied");
  } catch {
    toast(url);
  }
}

/* ---------- Zoom & gestures ---------- */
function apply(animate = false) {
  const img = $(".fv__img", root);
  img.style.transition = animate ? "transform 0.35s cubic-bezier(0.16, 1, 0.3, 1)" : "none";
  img.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  root.classList.toggle("is-zoomed", view.scale > 1.01);
}

function resetZoom() {
  view = { scale: 1, x: 0, y: 0 };
  apply();
}

function clampPan() {
  const stage = $(".fv__stage", root).getBoundingClientRect();
  const maxX = (stage.width * (view.scale - 1)) / 2;
  const maxY = (stage.height * (view.scale - 1)) / 2;
  view.x = Math.max(-maxX, Math.min(maxX, view.x));
  view.y = Math.max(-maxY, Math.min(maxY, view.y));
}

/** Zoom so the point (clientX, clientY) stays under the finger / cursor. */
function setZoom(scale, clientX, clientY) {
  const stage = $(".fv__stage", root).getBoundingClientRect();
  const cx = stage.left + stage.width / 2;
  const cy = stage.top + stage.height / 2;
  const px = clientX ?? cx;
  const py = clientY ?? cy;
  const ratio = scale / view.scale;
  view.x = (px - cx) * (1 - ratio) + view.x * ratio;
  view.y = (py - cy) * (1 - ratio) + view.y * ratio;
  view.scale = scale;
  if (scale <= 1) view = { scale: 1, x: 0, y: 0 };
  clampPan();
  apply(true);
}

function initGestures(stage) {
  const pointers = new Map();
  let start = null;
  let pinch = null;
  let lastTap = 0;
  let moved = false;

  stage.addEventListener("pointerdown", (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale };
      start = null;
    } else {
      start = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    }
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const scale = Math.max(1, Math.min(MAX_ZOOM, pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.dist)));
      view.scale = scale;
      clampPan();
      apply();
      moved = true;
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (view.scale > 1.01) {
      view.x = start.vx + dx;
      view.y = start.vy + dy;
      clampPan();
      apply();
    } else if (moved) {
      // Follow the finger for swipe feedback.
      view.x = dx;
      view.y = Math.max(0, dy) * 0.6;
      apply();
    }
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (!start || pointers.size) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (view.scale <= 1.01 && moved) {
      if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(dy)) return step(dx < 0 ? 1 : -1);
      if (dy > CLOSE_SWIPE_PX && Math.abs(dy) > Math.abs(dx)) return close();
      resetZoom();
      return apply(true);
    }
    if (moved) return;
    // Tap: mouse click zooms immediately, touch needs a double-tap.
    const now = Date.now();
    if (e.pointerType === "mouse" || now - lastTap < 320) {
      setZoom(view.scale > 1.01 ? 1 : TAP_ZOOM, e.clientX, e.clientY);
      lastTap = 0;
    } else {
      lastTap = now;
    }
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    start = null;
    if (view.scale <= 1.01) resetZoom();
  });

  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const next = Math.max(1, Math.min(MAX_ZOOM, view.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    setZoom(next, e.clientX, e.clientY);
  }, { passive: false });
}

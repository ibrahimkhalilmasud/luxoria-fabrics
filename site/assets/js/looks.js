/* Lookbook: dresses made from Luxoria fabrics, shown on models, each linked to the fabric to buy. */
import { $, $$, CFG, esc, ICON_CHECK, ICON_PLUS, lockScroll, qtyText, syncCartButtons, titleOf, toggleCart, whatsappHref } from "./core.js";

const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.5"/></svg>';
const ICON_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
const ICON_WA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 8.5c0 3.5 2.6 6.5 6.4 6.6l.9-1.5-1.8-.9-.8.8c-1.2-.5-2.2-1.5-2.7-2.7l.8-.8-.9-1.8-1.5.9" fill="currentColor"/></svg>';
const SWIPE_PX = 50;

let looksPromise = null;

/** Lookbook entries with their fabrics resolved against the live catalogue (hidden fabrics dropped). */
export function loadLooks(byId) {
  looksPromise ??= fetch("data/lookbook.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(`Lookbook HTTP ${r.status}`); return r.json(); });
  return looksPromise.then((data) => ({
    collections: data.collections,
    looks: data.looks.map((l) => ({ ...l, products: l.fabrics.map((id) => byId.get(id)).filter(Boolean) })),
  }));
}

export const lookTitle = (l) => {
  if (l.products[0]) return titleOf(l.products[0]);
  const num = l.code.match(/^\d+\s*[A-Z]?(?![A-Z])/)?.[0].replace(/\s+/g, "");
  return num ? `${l.collection} ${num}` : `${l.collection} · ${l.code}`;
};
export const lookUrl = (l) => new URL(`lookbook.html#look/${encodeURIComponent(l.id)}`, location.href).href;

/** Best looks for a teaser strip, taking turns between collections so all of them show. */
export function featuredLooks(looks, n) {
  const groups = new Map();
  // Looks whose fabric can be bought right away come first.
  [...looks].sort((a, b) => (b.products.length > 0) - (a.products.length > 0) || b.score - a.score).forEach((l) => {
    if (!groups.has(l.collection)) groups.set(l.collection, []);
    groups.get(l.collection).push(l);
  });
  const out = [];
  for (let round = 0; out.length < n && [...groups.values()].some((g) => g.length > round); round++) {
    groups.forEach((g) => { if (out.length < n && g[round]) out.push(g[round]); });
  }
  return out;
}

export function lookCardHtml(l, i) {
  const ph = l.photos[0];
  const cta = l.products.length ? "Shop the fabric" : "Ask about this look";
  return `<article class="look" style="--i:${i}">
    <button class="look__open" data-look="${esc(l.id)}" aria-label="${esc(lookTitle(l))}: see the look and its fabric">
      <img data-src="${esc(ph.thumb)}" alt="Model wearing a dress in ${esc(lookTitle(l))}, ${esc(l.collection)}" width="${Math.round(ph.w * 560 / ph.h)}" height="560" decoding="async">
      <span class="look__shade" aria-hidden="true"></span>
      <span class="look__text">
        <em>${esc(l.collection)}</em>
        <strong>${esc(lookTitle(l))}</strong>
        <span class="look__cta">${cta} <span aria-hidden="true">→</span></span>
      </span>
    </button>
  </article>`;
}

/* ---------- Full-screen look viewer ---------- */
const view = { list: [], index: 0, photo: 0, el: null, lastFocus: null, syncHash: false };

function ensureViewer() {
  if (view.el) return view.el;
  const el = document.createElement("div");
  el.className = "lk";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "lkTitle");
  el.innerHTML = `
    <div class="lk__stage">
      <img class="lk__img" id="lkImg" alt="">
      <button class="lk__nav lk__nav--prev" data-step="-1" aria-label="Previous look">${ICON_PREV}</button>
      <button class="lk__nav lk__nav--next" data-step="1" aria-label="Next look">${ICON_NEXT}</button>
      <div class="lk__thumbs" id="lkThumbs" role="group" aria-label="Photos of this look"></div>
    </div>
    <aside class="lk__info">
      <p class="eyebrow" id="lkEyebrow"></p>
      <h2 id="lkTitle"></h2>
      <p class="lk__detail" id="lkDetail"></p>
      <div class="lk__made" id="lkMade"></div>
      <div class="lk__actions" id="lkActions"></div>
      <p class="lk__note">Every fabric is a finite length. Swatches and a live video viewing are available on request.</p>
    </aside>
    <button class="lk__close" data-close aria-label="Close">${ICON_CLOSE}</button>`;
  document.body.append(el);

  el.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) return closeLook();
    // On the home page the fabric opens in its own viewer, so step out of this one.
    if (e.target.closest('a[href^="index.html#fabric/"]') && /(^|\/)(index\.html)?$/.test(location.pathname)) return closeLook();
    const step = e.target.closest("[data-step]");
    if (step) return show(view.index + Number(step.dataset.step), 0);
    const thumb = e.target.closest("[data-photo]");
    if (thumb) return showPhoto(Number(thumb.dataset.photo));
    const add = e.target.closest("[data-cart-btn]");
    if (add) {
      const p = view.list[view.index].products.find((x) => x.id === add.dataset.cartBtn);
      if (p) toggleCart(p);
      syncCartButtons(el);
      return;
    }
    if (e.target.closest("[data-add-all]")) addAll();
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLook();
    else if (e.key === "ArrowRight") show(view.index + 1, 0);
    else if (e.key === "ArrowLeft") show(view.index - 1, 0);
    else if (e.key === "Tab") trapFocus(e);
  });
  let startX = 0;
  const stage = $(".lk__stage", el);
  stage.addEventListener("touchstart", (e) => { startX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) < SWIPE_PX) return;
    const look = view.list[view.index];
    const next = view.photo + (dx < 0 ? 1 : -1);
    if (next >= 0 && next < look.photos.length) showPhoto(next);
    else show(view.index + (dx < 0 ? 1 : -1), 0);
  }, { passive: true });
  view.el = el;
  return el;
}

function trapFocus(e) {
  const items = $$("button, a[href]", view.el).filter((x) => x.offsetParent !== null);
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function addAll() {
  const look = view.list[view.index];
  const btns = $$("[data-cart-btn]", view.el);
  look.products.forEach((p) => {
    if (btns.find((b) => b.dataset.cartBtn === p.id)?.getAttribute("aria-pressed") !== "true") toggleCart(p);
  });
  syncCartButtons(view.el);
}

function fabricRow(p) {
  const status = p.status && p.status !== "available" ? ` · ${p.status[0].toUpperCase()}${p.status.slice(1)}` : "";
  return `<div class="lk__fabric">
    <img src="${esc(p.thumb)}" alt="" width="44" height="88" loading="lazy">
    <div>
      <strong>${esc(titleOf(p))}</strong>
      <span>${esc([p.composition, p.designNo && `Design ${p.designNo}`].filter(Boolean).join(" · "))}</span>
      <em>${esc(qtyText(p.quantity))} available${esc(status)}</em>
      <a href="index.html#fabric/${encodeURIComponent(p.id)}">See the fabric up close</a>
    </div>
    <button class="lk__add" data-cart-btn="${esc(p.id)}" aria-pressed="false" aria-label="Add to cart">${ICON_PLUS}</button>
  </div>`;
}

function render() {
  const look = view.list[view.index];
  $("#lkEyebrow").textContent = `${look.collection} · Look ${look.code}`;
  $("#lkTitle").textContent = lookTitle(look);
  $("#lkDetail").textContent = look.products.length
    ? "The dress is cut from this fabric. Reserve the length and we will send a swatch, a video and a quotation."
    : "Our advisors will tell you which fabric this dress is cut from and how many metres remain.";
  $("#lkMade").innerHTML = look.products.length
    ? `<p class="lk__label">Made with ${look.products.length > 1 ? `one of these ${look.products.length} lengths` : "this fabric"}</p>${look.products.map(fabricRow).join("")}`
    : "";
  const names = look.products.map(titleOf).filter((v, i, a) => a.indexOf(v) === i).join(", ");
  const about = `Look ${look.code}${names ? ` (${names})` : ""}`;
  const reserve = `Hello ${CFG.brand}, I love ${about} from your lookbook and would like to reserve the fabric. ${lookUrl(look)}`;
  const swatch = `Hello ${CFG.brand}, could you send me a swatch of the fabric used in ${about}? ${lookUrl(look)}`;
  $("#lkActions").innerHTML = `
    <a class="btn btn--gold" href="${esc(whatsappHref(reserve))}" target="_blank" rel="noopener">${ICON_WA}<span>Reserve on WhatsApp</span></a>
    ${look.products.length ? `<button class="btn btn--line" type="button" data-add-all>${ICON_CHECK}<span>Add ${look.products.length > 1 ? "all" : "fabric"} to cart</span></button>` : ""}
    <a class="btn btn--ghost" href="${esc(whatsappHref(swatch))}" target="_blank" rel="noopener"><span>Request a swatch</span></a>`;
  $("#lkThumbs").innerHTML = look.photos.length > 1
    ? look.photos.map((ph, i) => `<button data-photo="${i}" aria-label="Photo ${i + 1}"><img src="${esc(ph.thumb)}" alt="" width="40" height="56"></button>`).join("")
    : "";
  $$(".lk__nav", view.el).forEach((b) => { b.hidden = view.list.length < 2; });
  syncCartButtons(view.el);
  showPhoto(view.photo);
}

function showPhoto(i) {
  const look = view.list[view.index];
  view.photo = Math.max(0, Math.min(i, look.photos.length - 1));
  const ph = look.photos[view.photo];
  const img = $("#lkImg");
  img.classList.remove("is-loaded");
  img.onload = () => img.classList.add("is-loaded");
  img.src = ph.src;
  img.width = ph.w;
  img.height = ph.h;
  img.alt = `Model wearing a dress in ${lookTitle(look)}, photo ${view.photo + 1} of ${look.photos.length}`;
  $$("[data-photo]", view.el).forEach((b) => b.setAttribute("aria-current", String(Number(b.dataset.photo) === view.photo)));
}

function show(index, photo) {
  const n = view.list.length;
  view.index = ((index % n) + n) % n;
  view.photo = photo;
  render();
  if (view.syncHash) history.replaceState(null, "", `#look/${encodeURIComponent(view.list[view.index].id)}`);
}

export function openLook(list, index, { syncHash = false } = {}) {
  ensureViewer();
  view.list = list;
  view.syncHash = syncHash;
  view.lastFocus = document.activeElement;
  view.el.hidden = false;
  lockScroll(true);
  show(index, 0);
  requestAnimationFrame(() => view.el.classList.add("is-open"));
  $(".lk__close", view.el).focus();
}

export function closeLook() {
  if (!view.el || view.el.hidden) return;
  view.el.classList.remove("is-open");
  view.el.hidden = true;
  lockScroll(false);
  if (view.syncHash) history.replaceState(null, "", location.pathname + location.search);
  view.lastFocus?.focus?.();
}

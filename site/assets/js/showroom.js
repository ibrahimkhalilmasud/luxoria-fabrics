/* Showroom: an immersive, swipeable feed of every fabric with a one-tap "+" to add to cart. */
import { $, $$, byCategory, cart, esc, ICON_PLUS, initHeader, loadCatalog, qtyText, seriesText, storage, syncCartButtons, titleOf, toggleCart } from "./core.js";
import { openViewer } from "./viewer.js";

const STORE_DIR = "luxoria.showroomDir";
const state = { products: [], list: [], category: "", dir: "vertical" };

function defaultDirection() {
  return matchMedia("(min-width: 900px) and (pointer: fine)").matches ? "horizontal" : "vertical";
}

function slideHtml(p, i) {
  const ratio = p.w && p.h ? p.w / p.h : 0.4;
  return `<figure class="slide" style="--ar:${ratio.toFixed(4)}" data-index="${i}">
    <button class="slide__media" data-open="${i}" aria-label="View ${esc(titleOf(p))} full screen">
      <img src="${esc(p.image)}" alt="${esc(titleOf(p))} — ${esc(p.colourFamily)} ${esc(p.category)}" width="${p.w}" height="${p.h}" loading="lazy" decoding="async">
    </button>
    <figcaption class="slide__caption">
      <strong>${esc(titleOf(p))}</strong>
      <span>${esc([p.category, p.composition, seriesText(p)].filter(Boolean).join(" · "))}</span>
      <em>${esc(qtyText(p.quantity))} available</em>
    </figcaption>
    <button class="slide__add" data-cart-btn="${esc(p.id)}" aria-pressed="false" aria-label="Add to cart">${ICON_PLUS}</button>
  </figure>`;
}

function render() {
  state.list = state.products.filter((p) => !state.category || p.category === state.category);
  const feed = $("#feed");
  feed.className = `feed feed--${state.dir}`;
  feed.innerHTML = state.list.map(slideHtml).join("");
  $$("img", feed).forEach((img) => {
    if (img.complete) img.classList.add("is-loaded");
    else img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
  });
  syncCartButtons(feed);
  feed.scrollTo({ top: 0, left: 0 });
  $("#feedCount").textContent = `${state.list.length.toLocaleString()} pieces`;
  $$("[data-dir]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.dir === state.dir)));
  $$("[data-cat]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.cat === state.category)));
  updateProgress();
}

function renderCategories() {
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort(byCategory);
  $("#feedCats").innerHTML = ["", ...cats].map((c) =>
    `<button class="chip" data-cat="${esc(c)}" aria-pressed="false">${esc(c || "All")}</button>`).join("");
  $("#feedCats").hidden = cats.length < 2;
}

function currentIndex() {
  const feed = $("#feed");
  const slides = $$(".slide", feed);
  const fr = feed.getBoundingClientRect();
  const mid = state.dir === "vertical" ? fr.top + fr.height / 2 : fr.left + fr.width / 2;
  let best = 0;
  let bestDist = Infinity;
  slides.forEach((s, i) => {
    const r = s.getBoundingClientRect();
    const c = state.dir === "vertical" ? r.top + r.height / 2 : r.left + r.width / 2;
    const d = Math.abs(c - mid);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

function goTo(i) {
  const slide = $$(".slide", $("#feed"))[Math.max(0, Math.min(i, state.list.length - 1))];
  slide?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
}

let progressFrame = 0;
function updateProgress() {
  cancelAnimationFrame(progressFrame);
  progressFrame = requestAnimationFrame(() => {
    const feed = $("#feed");
    const max = state.dir === "vertical" ? feed.scrollHeight - feed.clientHeight : feed.scrollWidth - feed.clientWidth;
    const pos = state.dir === "vertical" ? feed.scrollTop : feed.scrollLeft;
    $("#feedProgress").style.transform = `scaleX(${max > 0 ? pos / max : 0})`;
  });
}

function bind() {
  const feed = $("#feed");
  feed.addEventListener("click", (e) => {
    const add = e.target.closest("[data-cart-btn]");
    if (add) {
      const p = state.list.find((x) => x.id === add.dataset.cartBtn);
      if (p) toggleCart(p);
      return;
    }
    const open = e.target.closest("[data-open]");
    if (open) openViewer(state.list, Number(open.dataset.open), { onIndex: goTo });
  });
  feed.addEventListener("scroll", updateProgress, { passive: true });
  // A normal mouse wheel scrolls the horizontal gallery sideways.
  feed.addEventListener("wheel", (e) => {
    if (state.dir !== "horizontal" || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    feed.scrollBy({ left: e.deltaY * 1.2 });
  }, { passive: false });

  $("#feedTools").addEventListener("click", (e) => {
    const dir = e.target.closest("[data-dir]")?.dataset.dir;
    if (dir) {
      const i = currentIndex();
      state.dir = dir;
      storage.set(STORE_DIR, dir);
      render();
      requestAnimationFrame(() => goTo(i));
      return;
    }
    const cat = e.target.closest("[data-cat]");
    if (cat) {
      state.category = cat.dataset.cat;
      render();
    }
  });
  $("#feedPrev").addEventListener("click", () => goTo(currentIndex() - 1));
  $("#feedNext").addEventListener("click", () => goTo(currentIndex() + 1));

  document.addEventListener("keydown", (e) => {
    if (document.querySelector(".fv:not([hidden])") || e.target.closest("input, select, textarea")) return;
    const fwd = state.dir === "vertical" ? ["ArrowDown", "PageDown"] : ["ArrowRight"];
    const back = state.dir === "vertical" ? ["ArrowUp", "PageUp"] : ["ArrowLeft"];
    if (fwd.includes(e.key)) { e.preventDefault(); goTo(currentIndex() + 1); }
    if (back.includes(e.key)) { e.preventDefault(); goTo(currentIndex() - 1); }
  });
  cart.onChange(() => syncCartButtons(feed));
}

async function init() {
  initHeader();
  state.dir = storage.get(STORE_DIR, defaultDirection());
  try {
    const data = await loadCatalog();
    state.products = data.products;
    cart.prune(data.byId);
  } catch (err) {
    $("#feedCount").textContent = "The showroom could not be loaded. Please refresh.";
    throw err;
  }
  renderCategories();
  bind();
  render();
}

init();

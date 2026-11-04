/* Lookbook page: every look, filterable by collection; a look opens with its fabric to reserve. */
import { $, $$, cart, esc, initHeader, lazyImages, loadCatalog } from "./core.js";
import { closeLook, loadLooks, lookCardHtml, openLook } from "./looks.js";

const state = { looks: [], collections: [], collection: "", list: [] };

function readUrl() {
  state.collection = new URLSearchParams(location.search).get("c") || "";
}

function writeUrl() {
  const q = state.collection ? `?c=${encodeURIComponent(state.collection)}` : "";
  history.replaceState(null, "", `${location.pathname}${q}${location.hash}`);
}

function renderChips() {
  const counts = new Map(state.collections.map((c) => [c, state.looks.filter((l) => l.collection === c).length]));
  $("#lookCats").innerHTML = [["", "All", state.looks.length], ...state.collections.filter((c) => counts.get(c)).map((c) => [c, c, counts.get(c)])]
    .map(([value, label, n]) => `<button class="chip" data-c="${esc(value)}" aria-pressed="${value === state.collection}">${esc(label)}<small>${n}</small></button>`)
    .join("");
}

function render() {
  state.list = state.looks.filter((l) => !state.collection || l.collection === state.collection);
  const grid = $("#looks");
  grid.innerHTML = state.list.map((l, i) => lookCardHtml(l, i)).join("");
  lazyImages(grid);
  $("#lookCount").textContent = `${state.list.length} looks`;
  $$("[data-c]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.c === state.collection)));
}

function openFromHash() {
  const m = location.hash.match(/^#look\/(.+)$/);
  if (!m) return closeLook();
  const id = decodeURIComponent(m[1]);
  let i = state.list.findIndex((l) => l.id === id);
  if (i < 0) {
    state.collection = "";
    render();
    i = state.list.findIndex((l) => l.id === id);
  }
  if (i >= 0) openLook(state.list, i, { syncHash: true });
}

async function init() {
  initHeader();
  readUrl();
  try {
    const catalog = await loadCatalog();
    cart.prune(catalog.byId);
    const data = await loadLooks(catalog.byId);
    state.looks = data.looks;
    state.collections = data.collections;
  } catch (err) {
    $("#lookCount").textContent = "The lookbook could not be loaded. Please refresh the page.";
    throw err;
  }
  if (!state.collections.includes(state.collection)) state.collection = "";
  renderChips();
  render();
  $("#lookCats").addEventListener("click", (e) => {
    const b = e.target.closest("[data-c]");
    if (!b) return;
    state.collection = b.dataset.c;
    writeUrl();
    render();
  });
  $("#looks").addEventListener("click", (e) => {
    const b = e.target.closest("[data-look]");
    if (b) openLook(state.list, state.list.findIndex((l) => l.id === b.dataset.look), { syncHash: true });
  });
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
}

init();

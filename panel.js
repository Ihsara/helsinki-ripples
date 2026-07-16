// panel.js — the v2.2 right-side district panel: a collapsible two-level
// list (city -> suurpiiri group -> peruspiiri rows) that ONLY navigates:
// clicking fires onSelect(entry) (app.js flies the camera + highlights),
// hovering fires onHover(entry|null) (outline pre-glow). No filtering —
// district admission was retired in v2.2 (spec Q4-A).

const CITY_ORDER = ["Helsinki", "Espoo", "Vantaa", "Kauniainen"];

// Pure: schema-2 districts object -> ordered rows [{city, parent, entry, depth}].
export function flattenDistricts(districts) {
  if (!districts) return [];
  const rows = [];
  for (const city of CITY_ORDER) {
    const parents = districts[city];
    if (!Array.isArray(parents)) continue;
    for (const p of parents) {
      rows.push({ city, parent: null, entry: p, depth: 0 });
      for (const c of p.children || []) {
        rows.push({ city, parent: p, entry: c, depth: 1 });
      }
    }
  }
  return rows;
}

export function createDistrictPanel(rootEl, districts, { onSelect, onHover }) {
  const rows = flattenDistricts(districts);
  if (rows.length === 0) {
    rootEl.hidden = true;
    return { setActive() {}, render() {} };
  }

  rootEl.hidden = false;
  rootEl.innerHTML =
    '<button id="dp-tab" type="button" aria-expanded="false" ' +
    'aria-controls="dp-body">Districts</button>' +
    '<div id="dp-body" hidden><div id="dp-list" role="listbox"></div></div>';
  const tabEl = rootEl.querySelector("#dp-tab");
  const bodyEl = rootEl.querySelector("#dp-body");
  const listEl = rootEl.querySelector("#dp-list");

  tabEl.addEventListener("click", () => {
    const open = bodyEl.hidden;
    bodyEl.hidden = !open;
    tabEl.setAttribute("aria-expanded", String(open));
    rootEl.classList.toggle("open", open);
  });

  let activeEntry = null;
  const rowEls = new Map(); // entry object -> element (identity key: 7 duplicate
  // names in the baked data, e.g. Vantaa's Tikkurila parent + child, would
  // collide on a name-keyed map)

  function render() {
    listEl.textContent = "";
    rowEls.clear();
    let lastCity = null;
    for (const row of rows) {
      if (row.city !== lastCity) {
        lastCity = row.city;
        const h = document.createElement("div");
        h.className = "dp-city";
        h.textContent = row.city;
        listEl.appendChild(h);
      }
      const b = document.createElement("button");
      b.type = "button";
      b.className = row.depth === 0 ? "dp-parent" : "dp-child";
      b.textContent = row.entry.name;
      b.classList.toggle("active", row.entry === activeEntry);
      b.addEventListener("click", () => onSelect(row.entry));
      b.addEventListener("mouseenter", () => onHover(row.entry));
      rowEls.set(row.entry, b);
      listEl.appendChild(b);
    }
  }
  listEl.addEventListener("mouseleave", () => onHover(null));

  function setActive(entry) {
    const next = entry || null;
    if (next === activeEntry) return;
    if (activeEntry !== null) rowEls.get(activeEntry)?.classList.remove("active");
    activeEntry = next;
    if (next !== null) rowEls.get(next)?.classList.add("active");
  }

  render();
  return { setActive, render };
}

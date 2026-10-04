/* CC Medical Inventory — front end */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const fmtDT = (iso) => { if (!iso) return ""; const d = new Date(iso); return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }); };
const byName = (a, b) => String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

const D = { items: [], customers: [], options: [], serials: [], status: { stock: [], repair: [], return: [], core: [] }, me: null };
/* The four things the warehouse receives. issue = the tap-all-that-apply step (option kind + wording). */
const KINDS = {
  stock:  { label: "New stock",       short: "Stock",   hint: "Probes, systems or parts going on the shelf", needsCust: false,
            icon: '<path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>' },
  repair: { label: "Customer repair", short: "Repairs", hint: "Repair it and send it back to the customer", needsCust: true,
            issue: { kind: "problem", title: "What's wrong with it?", label: "Problems", add: "Describe the problem", none: "None noted" },
            icon: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4 2.5-2.5z"/>' },
  return: { label: "Customer return", short: "Returns", hint: "Equipment a customer is sending back", needsCust: true,
            issue: { kind: "reason", title: "Why is it coming back?", label: "Return reason", add: "Another reason", none: "No reason given" },
            icon: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-4"/>' },
  core:   { label: "Core return",     short: "Cores",   hint: "Old unit sent back for core credit", needsCust: true,
            icon: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><circle cx="12" cy="12" r="3"/>' },
};
const K = (k) => KINDS[k] || KINDS.stock;
const OPEN_REPAIR = ["Received", "Evaluating", "Awaiting approval", "In repair", "Ready to return"];
const STATUS_CLASS = {
  "In stock": "s-ok", "Pending": "s-info", "On loan": "s-warn", "Out on rental": "s-warn", "Sold / shipped": "s-done",
  "Received": "s-warn", "Evaluating": "s-warn", "Awaiting approval": "s-warn", "In repair": "s-info", "Ready to return": "s-ok", "Returned": "s-done",
  "Inspecting": "s-warn", "Back in stock": "s-ok", "Credit issued": "s-done", "Credit approved": "s-ok", "Credit denied": "s-done", "Closed": "s-done",
};
const usd = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const ON_HAND = ["In stock", "Pending", "On loan"];
const CLOSED_STATUS = ["Sold / shipped", "Returned", "Credit issued", "Credit approved", "Credit denied", "Closed"];
const CUSTOMER_TYPES = ["Hospital", "Imaging center", "Clinic / practice", "Mobile ultrasound", "Dealer / reseller", "Other"];

/* ---------- logo with fallback ---------- */
document.querySelectorAll("img.logo").forEach((img) => {
  img.addEventListener("error", () => {
    if (img.dataset.fallback && img.src !== img.dataset.fallback) { img.src = img.dataset.fallback; return; }
    img.hidden = true;
    const w = img.nextElementSibling; if (w && w.classList.contains("wordmark")) w.hidden = false;
  });
});

/* ---------- toast ---------- */
function toast(html, bad) { const t = $("toast"); t.innerHTML = html; t.className = "toast" + (bad ? " bad" : ""); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), bad ? 4500 : 3000); }

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", credentials: "same-origin", headers: {} };
  if (opts.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  let r;
  try { r = await fetch("/api" + path, init); } catch { throw new Error("No connection. Check the Wi-Fi and try again."); }
  let data = null; try { data = await r.json(); } catch {}
  if (r.status === 401 && !opts.auth) { showLogin(data && data.needsSetup); throw new Error("Please sign in again."); }
  if (!r.ok) throw new Error((data && data.error) || "That didn't work. Try again.");
  return data;
}
const run = async (fn) => { try { return await fn(); } catch (e) { toast(esc(e.message), true); } };

/* ---------- sign in ---------- */
let setupMode = false;
function showLogin(needsSetup) {
  setupMode = !!needsSetup;
  $("app").hidden = true; $("login").hidden = false; closeSheet();
  $("login-title").textContent = setupMode ? "Create the admin account" : "Inventory sign in";
  $("login-sub").textContent = setupMode ? "First time here. This account can add everyone else." : "Systems · Rentals · Repair";
  $("setup-name-wrap").hidden = !setupMode;
  $("l-pass").autocomplete = setupMode ? "new-password" : "current-password";
  $("l-go").textContent = setupMode ? "Create account" : "Sign in";
  $("l-err").hidden = true;
  setTimeout(() => (setupMode ? $("l-name") : $("l-user")).focus(), 50);
}
$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("l-user").value.trim(), password = $("l-pass").value;
  if (!username || !password) { $("l-err").textContent = "Enter your username and password."; $("l-err").hidden = false; return; }
  $("l-go").disabled = true;
  try {
    await api(setupMode ? "/setup" : "/login", { method: "POST", body: { username, password, name: $("l-name").value.trim() }, auth: true });
    $("l-pass").value = "";
    await boot();
  } catch (err) { $("l-err").textContent = err.message; $("l-err").hidden = false; }
  finally { $("l-go").disabled = false; }
});
$("userbtn").onclick = (e) => { e.stopPropagation(); $("usermenu").hidden = !$("usermenu").hidden; };
document.addEventListener("click", () => ($("usermenu").hidden = true));
$("adminbtn").onclick = () => setTab(tab === "users" ? "receive" : "users");
$("m-out").onclick = () => run(async () => { await api("/logout", { method: "POST", body: {} , auth: true }); showLogin(false); });
$("m-pass").onclick = () => openSheet(`<div class="sheet-head"><div><h3>Change password</h3></div><button class="x" aria-label="Close">×</button></div>
  <form class="sec" id="pw-form" novalidate>
    <label class="f"><span>Current password</span><input id="pw-cur" type="password" autocomplete="current-password"></label>
    <label class="f"><span>New password</span><input id="pw-new" type="password" autocomplete="new-password" placeholder="8+ characters"></label>
    <button class="btn primary" type="submit">Save new password</button></form>`, "pw", () => {
  $("pw-form").onsubmit = (e) => { e.preventDefault(); run(async () => { await api("/password", { method: "POST", body: { current: $("pw-cur").value, password: $("pw-new").value } }); closeSheet(); toast("Password changed"); }); };
});

/* ---------- data ---------- */
/* First load fetches everything; later loads fetch only what changed (the server's ?since=). */
let lastSync = "";
function mergeBy(list, rows, key) {
  const at = new Map(list.map((x, i) => [key(x), i]));
  rows.forEach((r) => { const k = key(r); if (at.has(k)) list[at.get(k)] = r; else { at.set(k, list.length); list.push(r); } });
}
function derive() {
  const cname = new Map(D.customers.map((c) => [c.id, c.name]));
  const byId = new Map(D.items.map((i) => [i.id, i]));
  D.items.forEach((i) => (i.customer_name = i.customer_id ? cname.get(i.customer_id) || null : null));
  (D.serials || []).forEach((r) => { const i = byId.get(r.last_item_id); r.last_status = i ? i.status : null; r.customer_name = i ? i.customer_name : null; });
  D.items.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
  D.customers.sort((a, b) => byName(a.name, b.name));
  (D.serials || []).sort((a, b) => (b.last_seen || "").localeCompare(a.last_seen || ""));
}
async function load(full) {
  const d = await api("/data" + (!full && lastSync ? "?since=" + encodeURIComponent(lastSync) : ""));
  if (d.full === false) {
    mergeBy(D.items, d.items, (x) => x.id);
    mergeBy(D.customers, d.customers, (x) => x.id);
    mergeBy(D.options, d.options, (x) => x.id);
    mergeBy(D.serials, d.serials, (x) => String(x.serial).toLowerCase());
    (d.deleted || []).forEach((g) => {
      if (g.kind === "item") D.items = D.items.filter((x) => x.id !== g.ref);
      if (g.kind === "customer") D.customers = D.customers.filter((x) => x.id !== g.ref);
      if (g.kind === "option") D.options = D.options.filter((x) => String(x.id) !== g.ref);
    });
  } else {
    D.items = d.items; D.customers = d.customers; D.options = d.options; D.serials = d.serials || [];
    if (d.status) D.status = d.status;
  }
  D.me = d.me;
  // Overlap by 5 seconds so a change saved at the same moment is never missed; merging makes repeats harmless.
  lastSync = d.now ? new Date(Date.parse(d.now) - 5000).toISOString() : "";
  derive();
  $("u-name").textContent = D.me.name || D.me.username;
  $("adminbtn").hidden = D.me.role !== "admin";
  $("c-items").textContent = D.items.filter((i) => !CLOSED_STATUS.includes(i.status)).length; $("c-cust").textContent = D.customers.length; $("c-ser").textContent = (D.serials || []).length;
}
const isAdmin = () => D.me && D.me.role === "admin";
const opt = (kind, parent) => D.options.filter((o) => o.kind === kind && (parent === undefined || (o.parent || "").toLowerCase() === (parent || "").toLowerCase())).map((o) => o.value).sort(byName);
const optRow = (kind, value, parent = "") => D.options.find((o) => o.kind === kind && o.value.toLowerCase() === value.toLowerCase() && (o.parent || "").toLowerCase() === parent.toLowerCase());
const cust = (id) => D.customers.find((c) => c.id === id);
async function addOption(kind, value, parent = "") {
  value = value.trim(); if (!value) throw new Error("Type a name first.");
  const existing = optRow(kind, value, parent); if (existing) return existing.value;
  const r = await api("/options", { method: "POST", body: { kind, value, parent } });
  D.options.push(r.option); return r.option.value;
}

/* ---------- tabs ---------- */
let tab = "receive";
function setTab(t) {
  if (t === "users" && !isAdmin()) t = "receive";
  tab = t; store.set("cc-tab", t);
  document.querySelectorAll("nav.tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"));
  document.querySelectorAll("nav.botnav button[data-tab]").forEach((b) => (b.dataset.tab === t ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  const sel = document.querySelector(`nav.tabs button[data-tab="${t}"]`); if (sel && sel.scrollIntoView) sel.scrollIntoView({ inline: "nearest", block: "nearest" });
  ["receive", "inventory", "serials", "customers", "users"].forEach((v) => ($("v-" + v).hidden = v !== t));
  if (t === "serials") renderSerials();
  if (t === "receive") renderWizard();
  if (t === "inventory") renderInv();
  if (t === "customers") renderCust();
  if (t === "users") renderUsers();
  $("adminbtn").setAttribute("aria-pressed", t === "users" ? "true" : "false");
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav.tabs button, nav.botnav button[data-tab]").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

/* =====================================================================
   RECEIVE — tap-through wizard
   ===================================================================== */
const blankW = () => ({ snRes: null, cost: "", dom: "", kind: "", ref: "", customer_id: "", category: "", cond: "", manufacturer: "", model: "", part_number: "", pnMsg: "", problems: [], qty: 1, serial: "", location: "", notes: "", step: 0, lastTag: "" });
let W = blankW();
const STEP_LABEL = { kind: "Type", customer: "Customer", category: "Category", cond: "Condition", manufacturer: "Manufacturer", model: "Model", problem: "Problem", details: "Details" };
const steps = () => {
  const k = K(W.kind);
  return ["kind", "manufacturer", "model", "category", "cond", ...(k.needsCust ? ["customer"] : []), ...(k.issue ? ["problem"] : []), "details"];
};
/* Earlier items teach the app: a part number knows its manufacturer, model and category; a model knows its category. */
const norm = (v) => String(v || "").trim().toLowerCase();
const findByPart = (pn) => D.items.find((i) => i.part_number && norm(i.part_number) === norm(pn));
const catForModel = (mfr, model) => { const i = D.items.find((x) => norm(x.manufacturer) === norm(mfr) && norm(x.model) === norm(model) && x.category); return i ? i.category : ""; };
let addOpen = false, filterText = "";
function go(i) { W.step = Math.max(0, Math.min(i, steps().length - 1)); addOpen = false; filterText = ""; W.pnMsg = ""; renderWizard(); window.scrollTo(0, 0); }
const next = () => go(W.step + 1);

function trailHtml() {
  const s = steps(); const out = [];
  for (let i = 0; i < W.step && i < s.length; i++) {
    const k = s[i]; let v = "";
    if (k === "kind") v = K(W.kind).label + (W.serial ? " · S/N " + W.serial : "");
    else if (k === "customer") v = (cust(W.customer_id) || {}).name || "";
    else if (k === "problem") v = W.problems.length ? W.problems.join(", ") : K(W.kind).issue.none;
    else if (k === "manufacturer") v = [W.manufacturer || "Unknown", W.part_number ? "P/N " + W.part_number : ""].filter(Boolean).join(" · ");
    else v = W[k] || "Skipped";
    out.push(`<button type="button" data-go="${i}" class="${k === "kind" ? "k-" + W.kind : ""}"><small>${k === "problem" ? K(W.kind).issue.label : STEP_LABEL[k]}</small>${esc(v)}</button>`);
  }
  return `<div class="trail">${out.join("")}</div>`;
}
function head(title, hint) {
  const s = steps();
  return `<div class="qhead"><div><div class="stepno">STEP ${W.step + 1} OF ${s.length}</div><h2>${esc(title)}</h2>${hint ? `<p class="sub" style="margin:0">${hint}</p>` : ""}</div></div>`;
}
function navRow(extra = "") {
  return `<div class="navrow">${W.step > 0 ? `<button type="button" class="btn ghost" data-back>← Back</button>` : "<span></span>"}${extra}</div>`;
}

/* Step 1 serial number box: look a unit up, then receive it with its details filled in */
function serialBox() {
  const r = W.snRes;
  let res = "";
  if (r && !r.found) res = `<p class="pnmsg"><b>${esc(r.serial)}</b> is new to the system. Pick what you're receiving below and it will be added to the serial registry.</p>`;
  if (r && r.found) {
    const u = r.serial || {}, latest = r.items[0];
    const name = [u.manufacturer, u.model].filter(Boolean).join(" ") || u.category || (latest && latest.name) || "Unit";
    const open = latest && !CLOSED_STATUS.includes(latest.status);
    res = `<div class="sncard">
      <div class="sntop"><div><div class="snname">${esc(name)}</div><div class="hint"><span class="mono">S/N ${esc(u.serial || W.serial)}</span>${u.part_number ? ` · P/N <span class="mono">${esc(u.part_number)}</span>` : ""}${u.category ? " · " + esc(u.category) : ""}${u.dom ? " · DOM " + esc(u.dom) : ""}</div></div>
        <div class="sncount"><b>${u.times_received || r.items.length}</b><span>time${(u.times_received || r.items.length) === 1 ? "" : "s"} received</span></div></div>
      ${latest ? `<div class="snlatest"><span class="pill ${STATUS_CLASS[latest.status] || "s-done"}">${esc(latest.status)}</span><span>${esc(K(latest.kind).label)}${latest.customer_name ? " · " + esc(latest.customer_name) : ""} · ${fmtDate(latest.updated_at)}</span><button type="button" class="linkbtn" data-item="${esc(latest.id)}">Open ${esc(latest.id)}</button></div>` : ""}
      ${open ? `<p class="snwarn">This unit is still open as <b>${esc(latest.id)}</b> (${esc(latest.status)}). If it's coming back from a rental or a customer, receive it as a return below; that starts a new record and notes it on the old one.</p>` : ""}
      <ul class="hist">${r.history.slice(0, 4).map((h) => `<li><time>${fmtDate(h.at)}</time><span>${esc(h.what)}</span></li>`).join("")}</ul>
      <div class="actions"><button type="button" class="btn" data-serial="${esc(u.serial || W.serial)}">Product history</button><button type="button" class="btn ghost" id="w-snclear">Clear</button></div>
    </div>`;
  }
  return `<form class="pnbox" id="w-snform" autocomplete="off"><label class="f"><span>Serial number</span><div class="pnrow"><input id="w-sn" class="mono" value="${esc(W.serial)}" placeholder="Scan or type a serial" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="search">${scanBtn("w-sn-scan")}<button class="btn primary" type="submit">Look up</button></div></label></form>${res}`;
}

/* generic one-tap chooser */
function chooser({ values, selected, field, addKind, addParent, addLabel, skip, multi }) {
  const f = filterText.toLowerCase();
  const shown = f ? values.filter((v) => v.toLowerCase().includes(f)) : values;
  const filter = values.length > 12 ? `<div class="filterbox search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="w-filter" type="search" placeholder="Find…" value="${esc(filterText)}"></div>` : "";
  const sel = multi ? new Set(selected.map((s) => s.toLowerCase())) : null;
  const btns = shown.map((v) => {
    const on = multi ? sel.has(v.toLowerCase()) : (selected || "").toLowerCase() === v.toLowerCase();
    return `<button type="button" class="choice" data-pick="${esc(v)}" aria-pressed="${on}">${esc(v)}${multi ? `<span class="tick">${on ? "✓" : ""}</span>` : ""}</button>`;
  }).join("");
  const add = addKind ? (addOpen
    ? `<form class="addrow" id="w-addform"><input id="w-addval" placeholder="${esc(addLabel)}" value="${esc(filterText)}" autocomplete="off"><button class="btn primary" type="submit">Add</button><button class="btn" type="button" data-addcancel>Cancel</button></form>`
    : `<button type="button" class="choice add" data-addopen>+ Add new</button>`) : "";
  const sk = skip ? `<button type="button" class="choice skip" data-skip>${esc(skip)}</button>` : "";
  return `${filter}<div class="choices">${btns}${add}${sk}</div>${!shown.length && f ? `<p class="hint">Nothing matches "${esc(filterText)}". Tap + Add new to create it.</p>` : ""}`;
}

function renderWizard() {
  const el = $("wiz"); const k = steps()[W.step];
  let body = "";
  if (k === "kind") {
    body = `${head("What are you receiving?")}${serialBox()}
      <div class="or"><span>${W.serial ? `receive S/N ${esc(W.serial)} as` : "or pick what you're receiving"}</span></div>
      <div class="kindgrid">${Object.entries(KINDS).map(([key, k]) => `<button type="button" class="kindbtn ${key}" data-kind="${key}"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${k.icon}</svg><b>${k.label}</b><span>${k.hint}</span></button>`).join("")}</div>`;
  } else if (k === "customer") {
    const f = filterText.toLowerCase();
    const list = D.customers.slice().sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")).filter((c) => !f || [c.name, c.facility, c.phone].join(" ").toLowerCase().includes(f));
    body = `${head(W.kind === "repair" ? "Whose is it?" : "Which customer sent it back?", "Pick the customer, or add them once and they'll be a button from now on.")}
      <div class="filterbox search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="w-filter" type="search" placeholder="Find a customer…" value="${esc(filterText)}"></div>
      <div class="choices">${list.slice(0, 40).map((c) => `<button type="button" class="choice" data-cust="${esc(c.id)}" aria-pressed="${c.id === W.customer_id}"><span>${esc(c.name)}${c.facility || c.phone ? `<small>${esc([c.facility, c.phone].filter(Boolean).join(" · "))}</small>` : ""}</span></button>`).join("")}
      ${addOpen ? `<form class="addrow" id="w-custform" style="grid-template-columns:1fr"><div class="grid2"><label class="f"><span>Name</span><input id="wc-name" value="${esc(filterText)}" placeholder="Person or facility"></label><label class="f"><span>Phone</span><input id="wc-phone" type="tel" placeholder="(949) 555-0100"></label></div><div class="actions"><button class="btn primary" type="submit">Add customer</button><button class="btn" type="button" data-addcancel>Cancel</button></div></form>`
        : `<button type="button" class="choice add" data-addopen>+ New customer</button>`}</div>
      ${list.length > 40 ? `<p class="hint">Showing 40 of ${list.length}. Type to narrow the list.</p>` : ""}`;
  } else if (k === "category") {
    body = head("Category") + chooser({ values: opt("category"), selected: W.category, addKind: "category", addLabel: "New category name" });
  } else if (k === "cond") {
    body = head("Condition") + chooser({ values: opt("condition"), selected: W.cond, addKind: "condition", addLabel: "New condition", skip: "Skip" });
  } else if (k === "manufacturer") {
    body = head("Who makes it?", "Tap the manufacturer, or enter a part number to fill everything in.")
      + `<form class="pnbox" id="w-pnform" autocomplete="off"><label class="f"><span>Part number</span><div class="pnrow"><input id="w-pn" class="mono" value="${esc(W.part_number)}" placeholder="Scan or type, e.g. 5418486" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="search">${scanBtn("w-pn-scan")}<button class="btn primary" type="submit">Look up</button></div></label>
        ${W.pnMsg ? `<p class="pnmsg">${W.pnMsg}</p>` : ""}</form>
        <div class="or"><span>or pick the manufacturer</span></div>`
      + chooser({ values: opt("manufacturer"), selected: W.manufacturer, addKind: "manufacturer", addLabel: "Manufacturer name", skip: "Unknown / skip" });
  } else if (k === "model") {
    const vals = W.manufacturer ? opt("model", W.manufacturer) : [];
    body = head(W.manufacturer ? `${W.manufacturer} model` : "Model", W.manufacturer ? (vals.length ? "" : `No ${esc(W.manufacturer)} models yet. Add the first one.`) : "No manufacturer picked, so there are no saved models. Type it in the next step's notes, or go back.")
      + (W.manufacturer ? chooser({ values: vals, selected: W.model, addKind: "model", addParent: W.manufacturer, addLabel: "Model, e.g. C1-5-D", skip: "Unknown / skip" })
        : `<div class="choices"><button type="button" class="choice skip" data-skip>Continue</button></div>`);
  } else if (k === "problem") {
    const is = K(W.kind).issue;
    body = head(is.title, "Tap all that apply.") + chooser({ values: opt(is.kind), selected: W.problems, addKind: is.kind, addLabel: is.add, multi: true })
      + navRow(`<button type="button" class="btn primary" data-next>${W.problems.length ? "Next →" : is.none + " · Next →"}</button>`);
  } else if (k === "details") {
    const locs = opt("location");
    const name = [W.manufacturer, W.model].filter(Boolean).join(" ") || W.category;
    body = `${head("Last details")}
      <div class="details">
        <div class="summary"><div class="t">${esc(name)}</div><div class="hint">${esc([W.category, W.cond, K(W.kind).needsCust ? K(W.kind).label + " · " + ((cust(W.customer_id) || {}).name || "") : "Stock"].filter(Boolean).join(" · "))}</div></div>
        <div class="f"><span>Quantity</span><div class="qtybox"><button type="button" class="btn" data-qty="-1" aria-label="One less">−</button><input id="w-qty" type="number" inputmode="numeric" min="1" value="${W.qty}"><button type="button" class="btn" data-qty="1" aria-label="One more">+</button></div></div>
        <div class="f"><span>Part number (optional)</span><div class="inrow"><input id="w-part" class="mono" value="${esc(W.part_number)}" placeholder="Scan or type" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next" aria-label="Part number">${scanBtn("w-part-scan")}</div></div>
        ${W.kind !== "stock" ? `<label class="f"><span>RMA / order # (optional)</span><input id="w-ref" class="mono" value="${esc(W.ref)}" placeholder="e.g. RMA-1042" autocomplete="off" autocapitalize="characters"></label>` : ""}
        <div class="f"><span>Serial number (optional)</span><div class="inrow"><input id="w-serial" class="mono" value="${esc(W.serial)}" placeholder="Scan or type" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next" aria-label="Serial number">${scanBtn("w-serial-scan")}</div></div>
        <div class="grid2"><label class="f"><span>Cost per unit, $ (optional)</span><input id="w-cost" inputmode="decimal" value="${esc(W.cost)}" placeholder="e.g. 1200" autocomplete="off"></label>
        <label class="f"><span>Date of manufacture (optional)</span><input id="w-dom" class="mono" inputmode="numeric" value="${esc(W.dom)}" placeholder="YYYY-MM, e.g. 2024-08" autocomplete="off" maxlength="7"></label></div>
        <div class="f"><span>Shelf / bin</span>
          <div class="choices" id="w-locs">${locs.map((v) => `<button type="button" class="choice" data-loc="${esc(v)}" aria-pressed="${W.location.toLowerCase() === v.toLowerCase()}">${esc(v)}</button>`).join("")}
          ${addOpen ? `<form class="addrow" id="w-addform"><input id="w-addval" placeholder="e.g. A-03" autocomplete="off"><button class="btn primary" type="submit">Add</button><button class="btn" type="button" data-addcancel>Cancel</button></form>` : `<button type="button" class="choice add" data-addopen>+ Add bin</button>`}</div></div>
        <label class="f"><span>${W.kind === "repair" ? "Anything else about the problem? (optional)" : "Notes (optional)"}</span><textarea id="w-notes">${esc(W.notes)}</textarea></label>
        <button type="button" class="btn primary big" id="w-save">Save &amp; get tag number</button>
      </div>`;
  }

  if (W.lastTag) {
    el.innerHTML = `<div class="done qwrap"><div class="check"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5 9-10"/></svg></div>
      <h2>Saved</h2><p class="sub" style="margin:0">Write this tag number on the box.</p><div class="tag">${esc(W.lastTag)}</div>
      <div class="actions" style="justify-content:center"><button type="button" class="btn primary" id="w-again">Receive another</button><button type="button" class="btn" id="w-same">Another of the same</button><button type="button" class="btn" id="w-label">Print label</button><button type="button" class="btn ghost" id="w-view">View it</button></div></div>`;
    $("w-label").onclick = () => { const it = itemByTag(W.lastTag); if (it) openLabels([it], "Print tag label"); else toast("Still saving. Try again in a moment.", true); };
    $("w-again").onclick = () => { W = blankW(); renderWizard(); };
    $("w-same").onclick = () => { const keep = { ...W }; W = { ...keep, serial: "", snRes: null, dom: "", notes: "", qty: 1, lastTag: "", problems: [], ref: keep.ref }; W.step = steps().indexOf(K(keep.kind).issue ? "problem" : "details"); renderWizard(); };
    $("w-view").onclick = () => { const t = W.lastTag; setTab("inventory"); openItem(t); };
    return;
  }
  el.innerHTML = `${trailHtml()}<div class="qwrap">${body}</div>${k !== "kind" && k !== "problem" ? navRow() : ""}`;
  wireWizard(k);
}

function wireWizard(k) {
  const el = $("wiz");
  el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(+b.dataset.go)));
  el.querySelectorAll("[data-back]").forEach((b) => (b.onclick = () => go(W.step - 1)));
  el.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = async () => {
    // A serial typed but not looked up yet: look it up first so its details carry over.
    const typed = $("w-sn") ? $("w-sn").value.trim() : "";
    if (typed && (!W.snRes || norm(W.serial) !== norm(typed))) {
      const r = await run(() => api("/serial?s=" + encodeURIComponent(typed))); if (!r) return;
      W.serial = r.found && r.serial ? r.serial.serial : typed; W.snRes = r;
    }
    if (!typed && W.serial) { W.serial = ""; W.snRes = null; }
    if (W.kind !== b.dataset.kind) { const keep = W.kind; W.kind = b.dataset.kind; if (keep) { W.customer_id = ""; W.problems = []; } }
    const r = W.snRes;
    if (r && r.found) {   // known unit: fill in what we know and skip ahead
      const u = r.serial || {}, latest = r.items[0] || {};
      W.manufacturer = u.manufacturer || latest.manufacturer || ""; W.model = u.model || latest.model || "";
      W.part_number = u.part_number || latest.part_number || ""; W.category = u.category || latest.category || "";
      W.dom = u.dom || latest.dom || "";
      if (K(W.kind).needsCust && !W.customer_id && latest.customer_id) W.customer_id = latest.customer_id;
      if (W.category) { go(steps().indexOf("cond")); return; }
    }
    next();
  }));
  const submitForm = (f) => (f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event("submit", { cancelable: true })));
  if ($("w-sn-scan")) $("w-sn-scan").onclick = async () => {
    const code = await scan("Scan the serial number"); if (!code) return;
    const it = itemByTag(code);   // our own tag label: use that unit's serial
    $("w-sn").value = it && it.serial ? it.serial : code; submitForm($("w-snform"));
  };
  if ($("w-pn-scan")) $("w-pn-scan").onclick = async () => { const code = await scan("Scan the part number"); if (code) { $("w-pn").value = code; submitForm($("w-pnform")); } };
  if ($("w-serial-scan")) $("w-serial-scan").onclick = async () => { const code = await scan("Scan the serial number"); if (code) { $("w-serial").value = code; saveDetailFields(); } };
  if ($("w-part-scan")) $("w-part-scan").onclick = async () => { const code = await scan("Scan the part number"); if (code) { $("w-part").value = code; saveDetailFields(); } };
  const snf = $("w-snform");
  if (snf) snf.onsubmit = (e) => { e.preventDefault(); run(async () => {
    const sn = $("w-sn").value.trim();
    if (!sn) { $("w-sn").focus(); return; }
    const r = await api("/serial?s=" + encodeURIComponent(sn));
    W.serial = r.found && r.serial ? r.serial.serial : sn; W.snRes = r; renderWizard();
  }); };
  if ($("w-snclear")) $("w-snclear").onclick = () => { W.serial = ""; W.snRes = null; renderWizard(); $("w-sn").focus(); };
  const pnf = $("w-pnform");
  if (pnf) pnf.onsubmit = (e) => {
    e.preventDefault();
    const pn = $("w-pn").value.trim();
    if (!pn) { $("w-pn").focus(); return; }
    W.part_number = pn;
    const hit = findByPart(pn);
    if (hit) {
      W.part_number = hit.part_number; W.manufacturer = hit.manufacturer; W.model = hit.model; W.category = hit.category; W.pnMsg = "";
      toast(`P/N ${esc(pn)}: ${esc(hit.name)}`);
      go(steps().indexOf("cond"));
    } else {
      W.pnMsg = `<b>${esc(pn)}</b> is new. Pick the manufacturer below and the app will remember this part number next time.`;
      renderWizard();
    }
  };
  const fi = $("w-filter");
  if (fi) { fi.oninput = () => { filterText = fi.value; const pos = fi.selectionStart; renderWizard(); const n = $("w-filter"); n.focus(); n.setSelectionRange(pos, pos); }; }
  el.querySelectorAll("[data-addopen]").forEach((b) => (b.onclick = () => { addOpen = true; renderWizard(); const i = $("w-addval") || $("wc-name"); i && i.focus(); }));
  el.querySelectorAll("[data-addcancel]").forEach((b) => (b.onclick = () => { addOpen = false; renderWizard(); }));
  el.querySelectorAll("[data-skip]").forEach((b) => (b.onclick = () => { if (k in W) W[k] = ""; if (k === "manufacturer") W.model = ""; next(); }));
  el.querySelectorAll("[data-next]").forEach((b) => (b.onclick = next));

  const field = { category: "category", cond: "cond", manufacturer: "manufacturer", model: "model" }[k];
  const kindOf = { category: "category", cond: "condition", manufacturer: "manufacturer", model: "model", problem: (K(W.kind).issue || {}).kind, details: "location" }[k];

  el.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => {
    const v = b.dataset.pick;
    if (k === "problem") {
      const i = W.problems.findIndex((p) => p.toLowerCase() === v.toLowerCase());
      if (i >= 0) W.problems.splice(i, 1); else W.problems.push(v);
      renderWizard(); return;
    }
    if (k === "manufacturer" && W.manufacturer !== v) W.model = "";
    W[field] = v;
    if (k === "model") { const cat = catForModel(W.manufacturer, v); if (cat) { W.category = cat; go(steps().indexOf("cond")); return; } }
    next();
  }));
  el.querySelectorAll("[data-cust]").forEach((b) => (b.onclick = () => { W.customer_id = b.dataset.cust; next(); }));
  el.querySelectorAll("[data-loc]").forEach((b) => (b.onclick = () => { saveDetailFields(); W.location = W.location === b.dataset.loc ? "" : b.dataset.loc; renderWizard(); }));
  el.querySelectorAll("[data-qty]").forEach((b) => (b.onclick = () => { saveDetailFields(); W.qty = Math.max(1, (W.qty || 1) + +b.dataset.qty); $("w-qty").value = W.qty; }));

  const af = $("w-addform");
  if (af) af.onsubmit = (e) => { e.preventDefault(); run(async () => {
    if (k === "details") saveDetailFields();
    const v = await addOption(kindOf, $("w-addval").value, k === "model" ? W.manufacturer : "");
    addOpen = false; filterText = "";
    if (k === "problem") { if (!W.problems.some((p) => p.toLowerCase() === v.toLowerCase())) W.problems.push(v); renderWizard(); }
    else if (k === "details") { W.location = v; renderWizard(); }
    else { if (k === "manufacturer" && W.manufacturer !== v) W.model = ""; W[field] = v; next(); }
    toast(`Added “${esc(v)}” as a button`);
  }); };
  const cf = $("w-custform");
  if (cf) cf.onsubmit = (e) => { e.preventDefault(); run(async () => {
    const name = $("wc-name").value.trim(); if (!name) throw new Error("Add the customer's name.");
    const existing = D.customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) { W.customer_id = existing.id; next(); return; }
    const r = await api("/customers", { method: "POST", body: { name, phone: $("wc-phone").value.trim() } });
    D.customers.push(r.customer); W.customer_id = r.customer.id; $("c-cust").textContent = D.customers.length; next();
  }); };

  if (k === "details") {
    ["w-qty", "w-part", "w-ref", "w-serial", "w-cost", "w-dom", "w-notes"].forEach((id) => $(id) && $(id).addEventListener("input", saveDetailFields));
    $("w-part").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("w-serial").focus(); } });
    $("w-serial").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("w-notes").focus(); } }); // scanners send Enter
    $("w-save").onclick = () => run(async () => {
      saveDetailFields();
      $("w-save").disabled = true;
      try {
        const r = await api("/items", { method: "POST", body: { kind: W.kind, customer_id: W.customer_id, category: W.category, cond: W.cond, manufacturer: W.manufacturer, model: W.model, part_number: W.part_number, ref: W.ref, cost: W.cost, dom: W.dom, problems: W.problems, qty: W.qty, serial: W.serial, location: W.location, notes: W.notes } });
        W.lastTag = r.item.id; renderWizard(); window.scrollTo(0, 0);
        load().then(() => { if (tab !== "receive") setTab(tab); }).catch(() => {});
      } finally { const b = $("w-save"); if (b) b.disabled = false; }
    });
  }
}
function saveDetailFields() {
  if ($("w-qty")) W.qty = Math.max(1, parseInt($("w-qty").value, 10) || 1);
  if ($("w-serial")) W.serial = $("w-serial").value.trim();
  if ($("w-ref")) W.ref = $("w-ref").value.trim();
  if ($("w-part")) W.part_number = $("w-part").value.trim();
  if ($("w-cost")) W.cost = $("w-cost").value.trim();
  if ($("w-dom")) W.dom = $("w-dom").value.trim();
  if ($("w-notes")) W.notes = $("w-notes").value;
}

/* =====================================================================
   INVENTORY
   ===================================================================== */
const QUICK = [["", "All"], ["s:In stock", "In stock"], ["s:On loan", "On loan"], ["s:Pending", "Pending"], ["s:Out on rental", "On rental"], ["k:repair", "Repairs"], ["s:__open", "Open repairs"], ["s:Ready to return", "Ready to return"], ["k:return", "Returns"], ["k:core", "Cores"]];
let quick = "", showClosed = false;
function selOpts(list, sel, blank) { return `<option value="">${esc(blank)}</option>` + list.map(([v, t]) => `<option value="${esc(v)}"${v === sel ? " selected" : ""}>${esc(t)}</option>`).join(""); }
function refreshFilters() {
  const keep = (id) => $(id).value;
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort(byName).map((v) => [v, v]);
  const fc = keep("f-cat"), fm = keep("f-mfr"), fs = keep("f-status"), fl = keep("f-loc"), fu = keep("f-cust");
  $("f-cat").innerHTML = selOpts(uniq(D.items.map((i) => i.category)), fc, "All categories");
  $("f-mfr").innerHTML = selOpts(uniq(D.items.map((i) => i.manufacturer)), fm, "All manufacturers");
  $("f-status").innerHTML = selOpts([...new Set(Object.values(D.status).flat())].map((v) => [v, v]), fs, "All statuses");
  $("f-loc").innerHTML = selOpts(uniq(D.items.map((i) => i.location)), fl, "All bins");
  $("f-cust").innerHTML = selOpts([["__none", "No customer"], ...D.customers.map((c) => [c.id, c.name])], fu, "All customers");
}
function itemCard(i) {
  return `<button type="button" class="card k-${i.kind}" data-item="${esc(i.id)}"><span class="t">${esc(i.name)}${i.qty > 1 ? ` <span class="hint">× ${i.qty}</span>` : ""}</span><span class="pill ${STATUS_CLASS[i.status] || "s-done"}">${esc(i.status)}</span>
    <span class="m"><span class="id">${esc(i.id)}</span><span>${esc(i.category)}</span>${i.cond ? `<span>${esc(i.cond)}</span>` : ""}${i.kind === "return" || i.kind === "core" ? `<span class="kindtag k-${i.kind}">${K(i.kind).label}</span>` : ""}${i.ref ? `<span>RMA <span class="id">${esc(i.ref)}</span></span>` : ""}${i.part_number ? `<span>P/N <span class="id">${esc(i.part_number)}</span></span>` : ""}${i.serial ? `<span>S/N <span class="id">${esc(i.serial)}</span></span>` : ""}${i.location ? `<span>Bin ${esc(i.location)}</span>` : ""}${i.cost != null ? `<span>${usd(i.cost)}</span>` : ""}${i.dom ? `<span>DOM ${esc(i.dom)}</span>` : ""}${i.customer_name ? `<span class="chip">${esc(i.customer_name)}</span>` : ""}<span>${fmtDate(i.received_at)}</span></span></button>`;
}
function renderInv() {
  refreshFilters();
  $("i-quick").innerHTML = QUICK.map(([v, t]) => `<button type="button" data-q="${esc(v)}" aria-pressed="${v === quick}">${t}</button>`).join("");
  $("i-quick").querySelectorAll("button").forEach((b) => (b.onclick = () => { quick = b.dataset.q; renderInv(); }));
  const q = $("i-q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const fc = $("f-cat").value, fm = $("f-mfr").value, fs = $("f-status").value, fl = $("f-loc").value, fu = $("f-cust").value;
  const [qt, qv] = quick ? [quick.slice(0, 1), quick.slice(2)] : ["", ""];
  // Sold and closed records stay out of the way unless asked for: the toggle, a search, or a status filter.
  const closedOn = showClosed || q.length > 0 || !!fs || (qt === "s" && CLOSED_STATUS.includes(qv));
  let hiddenClosed = 0;
  const list = D.items.filter((i) => {
    if (!closedOn && CLOSED_STATUS.includes(i.status)) { hiddenClosed++; return false; }
    if (qt === "k" && i.kind !== qv) return false;
    if (qt === "s" && (qv === "__open" ? !OPEN_REPAIR.includes(i.status) || i.kind !== "repair" : i.status !== qv)) return false;
    if (fc && i.category !== fc) return false; if (fm && i.manufacturer !== fm) return false; if (fs && i.status !== fs) return false; if (fl && i.location !== fl) return false;
    if (fu === "__none" ? !!i.customer_id : fu && i.customer_id !== fu) return false;
    if (q.length) { const hay = [i.id, i.name, i.category, i.cond, i.manufacturer, i.model, i.part_number, i.ref, K(i.kind).label, i.serial, i.location, i.customer_name, i.notes, i.problems, i.status, i.received_by].join(" ").toLowerCase(); return q.every((t) => hay.includes(t)); }
    return true;
  });
  const filtered = q.length || quick || fc || fm || fs || fl || fu;
  $("i-clear").hidden = !filtered;
  const qtyOf = (st) => D.items.filter((i) => i.kind === "stock" && i.status === st).reduce((n, i) => n + (+i.qty || 0), 0);
  const held = D.items.filter((i) => i.kind === "stock" && ON_HAND.includes(i.status));
  const value = held.reduce((v, i) => v + (i.cost != null ? i.cost * (+i.qty || 0) : 0), 0), noCost = held.filter((i) => i.cost == null).length;
  $("inv-stats").innerHTML = [[qtyOf("In stock"), "Units in stock"], [qtyOf("On loan"), "On loan"],
    [D.items.filter((i) => i.kind === "repair" && OPEN_REPAIR.includes(i.status)).length, "Open repairs"],
    [D.items.filter((i) => (i.kind === "return" || i.kind === "core") && (i.status === "Received" || i.status === "Inspecting")).length, "Returns & cores to check"],
    [usd(Math.round(value)), noCost ? `Value on hand · ${noCost} without cost` : "Value on hand"]]
    .map(([n, t]) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`).join("");
  $("i-res").innerHTML = (filtered ? `${list.length} match` : `${list.length} current records · newest activity first`) +
    (hiddenClosed ? ` · ${hiddenClosed} sold or closed hidden <button type="button" class="linkbtn" id="i-showclosed">Show</button>` : (showClosed ? ` · <button type="button" class="linkbtn" id="i-hideclosed">Hide sold and closed</button>` : ""));
  if (list.length) { $("i-res").insertAdjacentHTML("beforeend", ` · <button type="button" class="linkbtn" id="i-labels">Print labels for these ${list.length}</button>`); $("i-labels").onclick = () => openLabels(list, `Tag labels for ${list.length} record${list.length === 1 ? "" : "s"}`); }
  if ($("i-showclosed")) $("i-showclosed").onclick = () => { showClosed = true; renderInv(); };
  if ($("i-hideclosed")) $("i-hideclosed").onclick = () => { showClosed = false; renderInv(); };
  if (!D.items.length) { $("i-list").innerHTML = `<div class="empty"><strong>Nothing received yet</strong>Items you log on Receive New Inventory show up here.<br><button type="button" class="btn primary" id="go-rcv">Receive the first item</button></div>`; $("go-rcv").onclick = () => setTab("receive"); return; }
  $("i-list").innerHTML = list.length ? list.slice(0, 300).map(itemCard).join("") + (list.length > 300 ? `<p class="hint">Showing 300 of ${list.length}. Search to narrow it down.</p>` : "") : `<div class="empty"><strong>No matches</strong>Try fewer words or clear a filter.</div>`;
}
["i-q", "f-cat", "f-mfr", "f-status", "f-loc", "f-cust"].forEach((id) => $(id).addEventListener("input", renderInv));
$("i-clear").onclick = () => { ["i-q", "f-cat", "f-mfr", "f-status", "f-loc", "f-cust"].forEach((id) => ($(id).value = "")); quick = ""; renderInv(); };
document.addEventListener("click", (e) => {
  const it = e.target.closest("[data-item]"); if (it) { openItem(it.dataset.item); return; }
  const c = e.target.closest("[data-custopen]"); if (c) { openCust(c.dataset.custopen); return; }
  const sn = e.target.closest("[data-serial]"); if (sn) openSerial(sn.dataset.serial);
});

/* ---------- sheet ---------- */
let sheetKey = null;
function openSheet(html, key, wire) {
  sheetKey = key; const s = $("sheet"); s.innerHTML = html; s.hidden = false; $("scrim").hidden = false; document.body.style.overflow = "hidden"; s.scrollTop = 0;
  s.querySelector(".x").onclick = closeSheet; wire && wire();
}
function closeSheet() { $("sheet").hidden = true; $("scrim").hidden = true; document.body.style.overflow = ""; sheetKey = null; }
$("scrim").onclick = closeSheet;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });

function dl(id, values) { return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join("")}</datalist>`; }
function openItem(id) {
  const i = D.items.find((x) => x.id === id); if (!i) { toast("That item isn't in the list anymore.", true); return; }
  const custOpts = (sel) => `<option value="">${K(i.kind).needsCust ? "Pick a customer" : "No customer"}</option>` + D.customers.slice().sort((a, b) => byName(a.name, b.name)).map((c) => `<option value="${esc(c.id)}"${c.id === sel ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  openSheet(`<div class="sheet-head"><div><h3>${esc(i.name)}</h3><div class="id">${esc(i.id)} · ${K(i.kind).label} · received ${fmtDate(i.received_at)}${i.received_by ? " by " + esc(i.received_by) : ""}</div></div><button class="x" aria-label="Close">×</button></div>
    <div class="sec"><h4>Status</h4><div class="statusbar" id="d-status">${D.status[i.kind].map((s) => `<button type="button" data-s="${esc(s)}" aria-pressed="${s === i.status}">${esc(s)}</button>`).join("")}</div></div>
    <div class="sec"><h4>Customer</h4><select id="d-cust" aria-label="Customer">${custOpts(i.customer_id)}</select>${i.customer_id ? `<button type="button" class="btn" data-custopen="${esc(i.customer_id)}">Open ${esc(i.customer_name || "customer")}</button>` : ""}</div>
    ${i.kind === "stock" && i.status !== "Sold / shipped" && i.qty > 0 ? `<div class="sec"><h4>Send out</h4>
      <div class="grid2"><label class="f"><span>How many</span><input id="d-coqty" type="number" min="1" max="${i.qty}" value="${i.qty}"></label>
      <label class="f"><span>To customer</span><select id="d-cocust">${custOpts(i.customer_id).replace("No customer", "No customer")}</select></label></div>
      <div class="actions">${["Sold / shipped", "On loan", "Out on rental", "Pending"].filter((st) => st !== i.status).map((st, n) => `<button type="button" class="btn${n === 0 ? " primary" : ""}" data-co="${st}">${st}</button>`).join("")}</div>
      <span class="hint">Sending part of the quantity splits it into its own record with a new tag. The rest stays here.</span></div>` : ""}
    <div class="sec"><h4>Details</h4>
      <div class="grid2">
        <label class="f"><span>Category</span><input id="d-category" list="dl-cat" value="${esc(i.category)}"></label>
        <label class="f"><span>Condition</span><input id="d-cond" list="dl-cond" value="${esc(i.cond)}"></label>
        <label class="f"><span>Manufacturer</span><input id="d-manufacturer" list="dl-mfr" value="${esc(i.manufacturer)}"></label>
        <label class="f"><span>Model</span><input id="d-model" list="dl-model" value="${esc(i.model)}"></label>
        <label class="f"><span>Part number</span><input id="d-part_number" class="mono" value="${esc(i.part_number)}"></label>
        <label class="f"><span>Serial</span><input id="d-serial" class="mono" value="${esc(i.serial)}"></label>
        <label class="f"><span>Quantity</span><input id="d-qty" type="number" min="0" value="${i.qty}"></label>
        <label class="f"><span>Cost per unit, $</span><input id="d-cost" inputmode="decimal" value="${i.cost != null ? esc(i.cost) : ""}" placeholder="Unknown"></label>
        <label class="f"><span>Date of manufacture</span><input id="d-dom" class="mono" value="${esc(i.dom)}" placeholder="YYYY-MM" maxlength="7"></label>
        <label class="f"><span>Shelf / bin</span><input id="d-location" list="dl-loc" value="${esc(i.location)}"></label>
      </div>
      ${K(i.kind).issue ? `<label class="f"><span>${K(i.kind).issue.label}</span><input id="d-problems" value="${esc(i.problems)}"></label>` : ""}
      ${i.kind !== "stock" ? `<label class="f"><span>RMA / order #</span><input id="d-ref" class="mono" value="${esc(i.ref)}"></label>` : ""}
      <label class="f"><span>Notes</span><textarea id="d-notes">${esc(i.notes)}</textarea></label>
      <div class="actions"><button type="button" class="btn primary" id="d-save">Save changes</button></div>
      ${dl("dl-cat", opt("category"))}${dl("dl-cond", opt("condition"))}${dl("dl-mfr", opt("manufacturer"))}${dl("dl-model", opt("model", i.manufacturer))}${dl("dl-loc", opt("location"))}</div>
    <div class="sec"><div class="actions"><button type="button" class="btn" id="d-label">Print tag label</button>${i.serial ? `<button type="button" class="btn" data-serial="${esc(i.serial)}">Product history for S/N ${esc(i.serial)}</button>` : ""}</div></div>
    <div class="sec"><h4>History</h4><ul class="hist" id="d-hist"><li><span class="hint">Loading…</span></li></ul></div>
    ${`<div class="sec"><h4>Remove</h4><div id="d-delwrap"><button type="button" class="btn danger" id="d-del">Delete this item</button></div></div>`}`, "item:" + id, () => {
    api(`/items/${encodeURIComponent(id)}/history`).then((r) => { const h = $("d-hist"); if (h && sheetKey === "item:" + id) h.innerHTML = r.history.map((x) => `<li><time>${fmtDT(x.at)}</time><span>${esc(x.what)}${x.by ? ` · <span class="hint">${esc(x.by)}</span>` : ""}</span></li>`).join("") || "<li><span>No history yet</span></li>"; }).catch(() => {});
    $("d-label").onclick = () => openLabels([i], "Print tag label");
    const after = async (msg, openId = id) => { await load(); renderAfterChange(); toast(msg); if (D.items.some((x) => x.id === openId)) openItem(openId); else closeSheet(); };
    $("d-status").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b || b.dataset.s === i.status) return; run(async () => { await api(`/items/${id}`, { method: "PATCH", body: { status: b.dataset.s } }); await after("Status: " + esc(b.dataset.s)); }); };
    $("d-cust").onchange = (e) => run(async () => { await api(`/items/${id}`, { method: "PATCH", body: { customer_id: e.target.value } }); await after(e.target.value ? "Customer assigned" : "Customer removed"); });
    document.querySelectorAll("[data-co]").forEach((b) => (b.onclick = () => run(async () => {
      const qty = parseInt($("d-coqty").value, 10) || 1;
      const r = await api(`/items/${id}/checkout`, { method: "POST", body: { qty, customer_id: $("d-cocust").value, status: b.dataset.co } });
      await after(r.newId ? `${qty} moved to <span class="mono">${esc(r.newId)}</span>` : esc(b.dataset.co));
    })));
    $("d-save").onclick = () => run(async () => {
      const body = {}; ["category", "cond", "manufacturer", "model", "part_number", "ref", "serial", "cost", "dom", "location", "notes", "problems"].forEach((f) => { const el = $("d-" + f); if (el) body[f] = el.value; });
      body.qty = $("d-qty").value;
      await api(`/items/${id}`, { method: "PATCH", body }); await after("Saved");
    });
    const del = $("d-del");
    if (del) del.onclick = () => { $("d-delwrap").innerHTML = `<div class="confirm"><p>Delete ${esc(i.id)} and its history for good?</p><div class="actions"><button type="button" class="btn danger solid" id="d-yes">Delete</button><button type="button" class="btn" id="d-no">Keep it</button></div></div>`;
      $("d-no").onclick = () => openItem(id); $("d-yes").onclick = () => run(async () => { await api(`/items/${id}`, { method: "DELETE", body: {} }); await load(); renderAfterChange(); closeSheet(); toast("Deleted " + esc(i.id)); }); };
  });
}
function renderAfterChange() { $("c-items").textContent = D.items.filter((i) => !CLOSED_STATUS.includes(i.status)).length; $("c-cust").textContent = D.customers.length; $("c-ser").textContent = D.serials.length; if (tab === "serials") renderSerials(); if (tab === "inventory") renderInv(); if (tab === "customers") renderCust(); }

/* =====================================================================
   SERIALS — every unit that has ever had a serial number
   ===================================================================== */
function renderSerials() {
  const q = $("s-q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const all = D.serials || [];
  const list = all.filter((r) => !q.length || q.every((t) => [r.serial, r.manufacturer, r.model, r.part_number, r.category, r.customer_name, r.last_item_id].join(" ").toLowerCase().includes(t)));
  $("s-res").textContent = q.length ? `${list.length} of ${all.length} serial numbers match` : `${all.length} serial numbers · most recent first`;
  if (!all.length) { $("s-list").innerHTML = `<div class="empty"><strong>No product history yet</strong>Every unit received with a serial number is added here automatically, with everything that happens to it.</div>`; return; }
  $("s-list").innerHTML = list.length ? list.slice(0, 300).map((r) => `<button type="button" class="card" data-serial="${esc(r.serial)}"><span class="t mono">${esc(r.serial)}</span>${r.last_status ? `<span class="pill ${STATUS_CLASS[r.last_status] || "s-done"}">${esc(r.last_status)}</span>` : `<span class="pill s-done">No open record</span>`}
    <span class="m"><span>${esc([r.manufacturer, r.model].filter(Boolean).join(" ") || r.category || "Unknown unit")}</span>${r.part_number ? `<span>P/N <span class="id">${esc(r.part_number)}</span></span>` : ""}<span>Received ${r.times_received}×</span>${r.customer_name ? `<span class="chip">${esc(r.customer_name)}</span>` : ""}<span>Last seen ${fmtDate(r.last_seen)}</span></span></button>`).join("")
    : `<div class="empty"><strong>No matches</strong>Check the serial number or try part of it.</div>`;
}
$("s-q").addEventListener("input", renderSerials);
async function openSerial(sn) {
  const r = await run(() => api("/serial?s=" + encodeURIComponent(sn))); if (!r) return;
  if (!r.found) { toast(`No product history for S/N ${esc(sn)}`); return; }
  const u = r.serial || { serial: sn }, name = [u.manufacturer, u.model].filter(Boolean).join(" ") || u.category || "Unit";
  openSheet(`<div class="sheet-head"><div><h3>${esc(name)}</h3><div class="id">S/N ${esc(u.serial)}${u.part_number ? " · P/N " + esc(u.part_number) : ""}${u.category ? " · " + esc(u.category) : ""}${u.dom ? " · DOM " + esc(u.dom) : ""}</div></div><button class="x" aria-label="Close">×</button></div>
    <div class="stats"><div class="stat"><b>${u.times_received ?? r.items.length}</b><span>Times received</span></div><div class="stat"><b>${u.first_seen ? fmtDate(u.first_seen).replace(/, \d{4}$/, "") : "—"}</b><span>First seen</span></div><div class="stat"><b>${u.last_seen ? fmtDate(u.last_seen).replace(/, \d{4}$/, "") : "—"}</b><span>Last seen</span></div></div>
    <div class="sec"><button type="button" class="btn primary" id="sn-receive">Receive this part</button></div>
    <div class="sec"><h4>Records (${r.items.length})</h4>${r.items.length ? `<div class="list">${r.items.map(itemCard).join("")}</div>` : `<p class="hint" style="margin:0">No current records. Past ones were deleted, but their history is kept below.</p>`}</div>
    <div class="sec"><h4>Product history</h4><ul class="hist">${r.history.map((h) => `<li><time>${fmtDT(h.at)}</time><span>${esc(h.what)}<br><span class="hint"><span class="mono">${esc(h.item_id || "")}</span>${h.kind ? " · " + esc(K(h.kind).label) : ""}${h.by ? " · " + esc(h.by) : ""}${h.item_exists ? "" : " · record deleted"}</span></span></li>`).join("") || "<li><span>No events yet</span></li>"}</ul></div>`, "serial:" + sn, () => {
    $("sn-receive").onclick = () => { closeSheet(); W = blankW(); W.serial = u.serial; W.snRes = r; setTab("receive"); };
  });
}

/* =====================================================================
   CUSTOMERS (CRM)
   ===================================================================== */
function custStats(c) { const mine = D.items.filter((i) => i.customer_id === c.id); return { total: mine.length, returns: mine.filter((i) => (i.kind === "return" || i.kind === "core") && !["Credit issued", "Credit approved", "Credit denied", "Closed", "Back in stock"].includes(i.status)).length, open: mine.filter((i) => i.kind === "repair" && OPEN_REPAIR.includes(i.status)).length, rental: mine.filter((i) => i.status === "Out on rental").length }; }
function renderCust() {
  const q = $("c-q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const list = D.customers.filter((c) => !q.length || q.every((t) => [c.name, c.phone, c.email, c.facility, c.type, c.address, c.notes].join(" ").toLowerCase().includes(t))).sort((a, b) => byName(a.name, b.name));
  $("c-res").textContent = q.length ? `${list.length} of ${D.customers.length} customers match` : `${D.customers.length} customers`;
  if (!D.customers.length) { $("c-list").innerHTML = `<div class="empty"><strong>No customers yet</strong>Add one here, or add them while receiving a repair or return.<br><button type="button" class="btn primary" id="c-add2">+ Add customer</button></div>`; $("c-add2").onclick = () => openCust(null); return; }
  $("c-list").innerHTML = list.length ? list.map((c) => { const s = custStats(c); return `<button type="button" class="card" data-custopen="${esc(c.id)}"><span class="t">${esc(c.name)}</span><span class="hint">${s.total} item${s.total === 1 ? "" : "s"}</span>
    <span class="m">${c.type ? `<span>${esc(c.type)}</span>` : ""}${c.facility ? `<span>${esc(c.facility)}</span>` : ""}${c.phone ? `<span class="id">${esc(c.phone)}</span>` : ""}${s.open ? `<span class="pill s-warn">${s.open} open repair${s.open === 1 ? "" : "s"}</span>` : ""}${s.rental ? `<span class="pill s-info">${s.rental} on rental</span>` : ""}${s.returns ? `<span class="pill s-warn">${s.returns} open return${s.returns === 1 ? "" : "s"}</span>` : ""}</span></button>`; }).join("")
    : `<div class="empty"><strong>No matches</strong>Try a different name or phone number.</div>`;
}
$("c-q").addEventListener("input", renderCust);
$("c-add").onclick = () => openCust(null);
function openCust(id) {
  const c = id ? cust(id) : null; if (id && !c) return;
  const mine = c ? D.items.filter((i) => i.customer_id === c.id) : [];
  const v = (f) => esc(c ? c[f] : "");
  openSheet(`<div class="sheet-head"><div><h3>${c ? esc(c.name) : "New customer"}</h3>${c ? `<div class="id">Customer since ${fmtDate(c.created_at)}</div>` : ""}</div><button class="x" aria-label="Close">×</button></div>
    ${c ? `<div class="sec"><h4>Their items (${mine.length})</h4>${mine.length ? `<div class="list">${mine.map(itemCard).join("")}</div>` : `<p class="hint" style="margin:0">Nothing tied to this customer yet.</p>`}
      <div class="actions">${["repair", "return", "core"].map((k) => `<button type="button" class="btn" data-intake="${k}">Receive ${K(k).label.replace("Customer ", "").toLowerCase()}</button>`).join("")}</div></div>` : ""}
    <form class="sec" id="cu-form" novalidate><h4>Contact</h4>
      <label class="f"><span>Name</span><input id="cu-name" value="${v("name")}" placeholder="Person or facility"></label>
      <div class="f"><span>Type</span><div class="statusbar" id="cu-type">${CUSTOMER_TYPES.map((t) => `<button type="button" data-t="${esc(t)}" aria-pressed="${c && c.type === t}">${esc(t)}</button>`).join("")}</div></div>
      <div class="grid2"><label class="f"><span>Facility / company</span><input id="cu-facility" value="${v("facility")}"></label>
      <label class="f"><span>Phone</span><input id="cu-phone" type="tel" value="${v("phone")}"></label>
      <label class="f"><span>Email</span><input id="cu-email" type="email" value="${v("email")}"></label></div>
      <label class="f"><span>Address</span><textarea id="cu-address">${v("address")}</textarea></label>
      <label class="f"><span>Notes</span><textarea id="cu-notes" placeholder="Billing contact, PO rules, shipping account…">${v("notes")}</textarea></label>
      <button class="btn primary" type="submit">${c ? "Save changes" : "Add customer"}</button></form>
    ${c ? `<div class="sec"><h4>Remove</h4><div id="cu-delwrap"><button type="button" class="btn danger" id="cu-del">Delete this customer</button></div></div>` : ""}`, "cust:" + (id || "new"), () => {
    let type = c ? c.type : "";
    $("cu-type").onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; type = type === b.dataset.t ? "" : b.dataset.t; $("cu-type").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.t === type)); };
    document.querySelectorAll("[data-intake]").forEach((b) => (b.onclick = () => { closeSheet(); W = blankW(); W.kind = b.dataset.intake; W.customer_id = c.id; W.step = 1; setTab("receive"); }));
    $("cu-form").onsubmit = (e) => { e.preventDefault(); run(async () => {
      const body = { type }; ["name", "facility", "phone", "email", "address", "notes"].forEach((f) => (body[f] = $("cu-" + f).value));
      if (c) { await api(`/customers/${c.id}`, { method: "PATCH", body }); await load(); renderAfterChange(); toast("Saved"); openCust(c.id); }
      else { const r = await api("/customers", { method: "POST", body }); await load(); renderAfterChange(); toast("Added " + esc(r.customer.name)); openCust(r.customer.id); }
    }); };
    const del = $("cu-del");
    if (del) del.onclick = () => { $("cu-delwrap").innerHTML = `<div class="confirm"><p>Delete ${esc(c.name)}?${mine.length ? ` Their ${mine.length} item${mine.length === 1 ? "" : "s"} stay in inventory without a customer.` : ""}</p><div class="actions"><button type="button" class="btn danger solid" id="cu-yes">Delete</button><button type="button" class="btn" id="cu-no">Keep</button></div></div>`;
      $("cu-no").onclick = () => openCust(id); $("cu-yes").onclick = () => run(async () => { await api(`/customers/${c.id}`, { method: "DELETE", body: {} }); await load(); renderAfterChange(); closeSheet(); toast("Deleted " + esc(c.name)); }); };
  });
}

/* =====================================================================
   USERS (admin)
   ===================================================================== */
let newRole = "standard";
$("nu-role").onclick = (e) => { const b = e.target.closest("[data-v]"); if (!b) return; newRole = b.dataset.v; $("nu-role").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.v === newRole)); };
$("u-add").onsubmit = (e) => { e.preventDefault(); run(async () => {
  await api("/users", { method: "POST", body: { name: $("nu-name").value, username: $("nu-user").value, password: $("nu-pass").value, role: newRole } });
  toast(`Added ${esc($("nu-user").value)}. Give them their password.`); ["nu-name", "nu-user", "nu-pass"].forEach((id) => ($(id).value = "")); renderUsers();
}); };
async function renderUsers() {
  const r = await run(() => api("/users")); if (!r) return;
  $("u-list").innerHTML = r.users.map((u) => `<div class="urow" data-uid="${u.id}"><div class="who"><b>${esc(u.name || u.username)}</b><div><span class="mono">${esc(u.username)}</span> · ${u.role === "admin" ? "Admin" : "Standard"}${u.active ? "" : " · <b style=\"color:var(--bad)\">No access</b>"}</div></div>
    <div class="actions"><button type="button" class="btn" data-act="pw">Reset password</button>${u.id === D.me.id ? "" : `<button type="button" class="btn" data-act="role">${u.role === "admin" ? "Make standard" : "Make admin"}</button><button type="button" class="btn ${u.active ? "danger" : ""}" data-act="active">${u.active ? "Remove access" : "Restore access"}</button>`}</div></div>`).join("");
  $("u-list").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => {
    const row = b.closest("[data-uid]"), uid = +row.dataset.uid, u = r.users.find((x) => x.id === uid);
    if (b.dataset.act === "pw") {
      const box = document.createElement("form"); box.className = "addrow"; box.innerHTML = `<input placeholder="New password for ${esc(u.username)} (8+)" autocomplete="off"><button class="btn primary" type="submit">Set</button><button class="btn" type="button">Cancel</button>`;
      row.appendChild(box); box.querySelector("input").focus(); box.querySelector("button[type=button]").onclick = () => box.remove();
      box.onsubmit = (e) => { e.preventDefault(); run(async () => { await api(`/users/${uid}`, { method: "PATCH", body: { password: box.querySelector("input").value } }); toast(`Password reset for ${esc(u.username)}`); if (uid === D.me.id) showLogin(false); else renderUsers(); }); };
      return;
    }
    const body = b.dataset.act === "role" ? { role: u.role === "admin" ? "standard" : "admin" } : { active: !u.active };
    run(async () => { await api(`/users/${uid}`, { method: "PATCH", body }); renderUsers(); });
  }));
}


/* =====================================================================
   SCANNING — phone camera (live video, or a photo when live video isn't available)
   ===================================================================== */
const VENDOR = { scanner: "/vendor/html5-qrcode.min.js", qr: "/vendor/qrcode.js" };
function ensureScript(globalName, src) {
  if (window[globalName]) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src; el.onload = () => resolve();
    el.onerror = () => reject(new Error("Couldn't load the scanner. Check the connection and try again."));
    document.head.appendChild(el);
  });
}
// A scanned label may hold a link (…/#tag=CC-…) or the bare code.
const codeFrom = (text) => { const t = String(text || "").trim(); const m = t.match(/#tag=([A-Za-z0-9-]+)/); return m ? m[1].toUpperCase() : t; };
const itemByTag = (code) => D.items.find((i) => i.id.toUpperCase() === String(code).toUpperCase());

let scanBusy = null;
function scan(title) {
  if (scanBusy) return scanBusy;
  scanBusy = new Promise((resolve) => {
    const box = $("scanner");
    box.innerHTML = `<div class="scanbox" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="scan-head"><h3>${esc(title)}</h3><button type="button" class="x" id="scan-x" aria-label="Close">×</button></div>
      <div id="scan-view"></div>
      <p class="scan-msg" id="scan-msg">Starting the camera…</p>
      <button type="button" class="btn torch" id="scan-torch" aria-pressed="false" hidden><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 3h10l-2 6H9z"/><path d="M9 9v11a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V9"/><path d="M12 13v3"/></svg><span>Flashlight</span></button>
      <div class="actions"><label class="btn" for="scan-file"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Take a photo instead</label>
      <input type="file" id="scan-file" accept="image/*" capture="environment" hidden>
      <button type="button" class="btn ghost" id="scan-cancel">Cancel</button></div></div>`;
    box.hidden = false; document.body.classList.add("scanning");
    beep.prime();
    let h = null, live = false, done = false;
    const msg = (t, bad) => { const m = $("scan-msg"); if (m) { m.textContent = t; m.classList.toggle("bad", !!bad); } };
    const stopLive = async () => { if (h && live) { live = false; try { await h.stop(); } catch {} } };
    const finish = async (text) => {
      if (done) return; done = true;
      await stopLive(); try { h && h.clear(); } catch {}
      box.hidden = true; box.innerHTML = ""; scanBusy = null; document.body.classList.remove("scanning");
      if (text) { beep(); if (navigator.vibrate) { try { navigator.vibrate(60); } catch {} } }
      resolve(text ? codeFrom(text) : null);
    };
    $("scan-x").onclick = () => finish(null);
    $("scan-cancel").onclick = () => finish(null);
    $("scan-file").onchange = async (e) => {
      const f = e.target.files && e.target.files[0]; if (!f || !h) return;
      msg("Reading the photo…"); await stopLive();
      try { finish(await h.scanFile(f, false)); }
      catch { msg("Couldn't find a barcode in that photo. Get closer, keep the code flat and in focus, and try again.", true); e.target.value = ""; }
    };
    ensureScript("__Html5QrcodeLibrary__", VENDOR.scanner).then(async () => {
      if (done) return;
      const L = window.__Html5QrcodeLibrary__, F = L.Html5QrcodeSupportedFormats;
      h = new L.Html5Qrcode("scan-view", { verbose: false, experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        formatsToSupport: [F.QR_CODE, F.DATA_MATRIX, F.CODE_128, F.CODE_39, F.CODE_93, F.EAN_13, F.UPC_A, F.ITF] });
      try {
        const box2 = (w, hh) => ({ width: Math.max(160, Math.floor(Math.min(w * 0.88, 460))), height: Math.max(120, Math.floor(Math.min(hh * 0.5, 280))) });
        const onRead = (text) => finish(text);
        try { // sharper picture for small serial barcodes; plain camera if the phone refuses
          await h.start({ facingMode: "environment" }, { fps: 12, qrbox: box2,
            videoConstraints: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: "continuous" }] } }, onRead, () => {});
        } catch (e1) {
          if (done) return;
          await h.start({ facingMode: "environment" }, { fps: 10, qrbox: box2 }, onRead, () => {});
        }
        live = true;
        if (done) { await stopLive(); return; }
        msg("Hold the barcode or QR label inside the box.");
        // Flashlight for dark shelves, on phones that allow it (most Android; iPhone doesn't yet)
        let caps = {}; try { caps = h.getRunningTrackCapabilities() || {}; } catch {}
        const tb = $("scan-torch");
        if (tb && caps.torch) {
          tb.hidden = false; let on = false;
          tb.onclick = async () => { try { on = !on; await h.applyVideoConstraints({ advanced: [{ torch: on }] }); tb.setAttribute("aria-pressed", on ? "true" : "false"); } catch { on = !on; } };
        }
      } catch {
        msg("The camera isn't available here. Use Take a photo instead.");
        try { h.clear(); } catch {} const v = $("scan-view"); if (v) v.innerHTML = "";
        const lb = document.querySelector('.scanbox label[for="scan-file"]'); if (lb) lb.classList.add("primary");
      }
    }).catch((e) => msg(e.message, true));
  });
  return scanBusy;
}
// Short confirmation beep. The audio is unlocked when the scanner opens (a tap), so it can play when a code is read.
function beep() {
  try { const a = beep.ctx; if (!a) return; const o = a.createOscillator(), g = a.createGain();
    o.type = "square"; o.frequency.value = 1760; g.gain.setValueAtTime(0.06, a.currentTime); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + 0.12);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + 0.12); } catch {}
}
beep.prime = () => { try { const C = window.AudioContext || window.webkitAudioContext; if (!C) return; beep.ctx = beep.ctx || new C(); if (beep.ctx.state === "suspended") beep.ctx.resume(); } catch {} };
const SCAN_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9v6M11 9v6M14 9v6M17 9v6"/></svg>';
const scanBtn = (id, label = "Scan") => `<button type="button" class="btn scanbtn" id="${id}" aria-label="${esc(label)}">${SCAN_ICON}<span>${esc(label)}</span></button>`;

// Scan to find: our tag opens the record; a serial opens its record or Product History; anything else is searched.
async function scanToFind() {
  const code = await scan("Scan a tag or serial number"); if (!code) return;
  const it = itemByTag(code);
  if (it) { setTab("inventory"); openItem(it.id); return; }
  const bySerial = D.items.filter((i) => i.serial && i.serial.toUpperCase() === code.toUpperCase());
  const open = bySerial.filter((i) => !CLOSED_STATUS.includes(i.status));
  if (open.length === 1) { setTab("inventory"); openItem(open[0].id); return; }
  if (bySerial.length) { openSerial(code); return; }
  setTab("inventory"); $("i-q").value = code; renderInv(); toast(`No record for ${esc(code)} yet. Showing search results.`);
}
$("i-scan").onclick = scanToFind;
// Phone bar Scan: on Receive it fills the serial box you're on; everywhere else it finds the unit.
$("b-scan").onclick = () => {
  if (tab === "receive") { const b = $("w-sn-scan") || $("w-serial-scan"); if (b) { b.scrollIntoView({ block: "center" }); b.click(); return; } }
  scanToFind();
};
// No signal (dead spots in the warehouse): show a bar so nobody thinks a save went through.
const netState = () => { $("netbar").hidden = navigator.onLine !== false; };
window.addEventListener("online", () => { netState(); if (D.me) run(() => load()); });
window.addEventListener("offline", netState); netState();
$("s-scan").onclick = async () => {
  const code = await scan("Scan a serial number"); if (!code) return;
  const it = itemByTag(code);
  const sn = it ? it.serial : code;
  if (sn && (D.serials || []).some((r) => r.serial.toUpperCase() === sn.toUpperCase())) { openSerial(sn); return; }
  $("s-q").value = code; renderSerials();
};

/* =====================================================================
   TAG LABELS — QR code + tag + model + serial, for a label printer or Avery sheets
   ===================================================================== */
const LABEL_LAYOUTS = {
  roll: { name: "Label printer, 2.25 × 1.25 in", note: "Fits DYMO 30334 and similar. In the print dialog pick that label size and set margins to None." },
  avery: { name: "Letter sheet, 30 per page (Avery 5160)", note: "In the print dialog choose Letter, scale 100% (Actual size), margins None." },
};
const labelLink = (tag) => `${location.origin}${location.pathname}#tag=${encodeURIComponent(tag)}`;
function qrSvg(text) {
  const q = window.qrcode(0, "M"); q.addData(text); q.make();
  return q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}
function labelHtml(i) {
  const lines = [i.serial ? `S/N ${i.serial}` : (i.part_number ? `P/N ${i.part_number}` : ""), [i.location ? `Bin ${i.location}` : "", i.dom ? `DOM ${i.dom}` : ""].filter(Boolean).join(" · ")].filter(Boolean);
  return `<div class="lbl"><div class="lbl-qr">${qrSvg(labelLink(i.id))}</div><div class="lbl-txt"><div class="lbl-tag">${esc(i.id)}</div><div class="lbl-name">${esc(i.name)}</div>${lines.map((l) => `<div class="lbl-line">${esc(l)}</div>`).join("")}<div class="lbl-co">CC Medical</div></div></div>`;
}
async function openLabels(items, title) {
  if (!items.length) { toast("No records to label."); return; }
  try { await ensureScript("qrcode", VENDOR.qr); } catch (e) { toast(esc(e.message), true); return; }
  let layout = store.get("cc-label") || "roll";
  const render = () => {
    const show = items.slice(0, 12);
    openSheet(`<div class="sheet-head"><div><h3>${esc(title)}</h3><div class="id">${items.length} label${items.length === 1 ? "" : "s"}</div></div><button class="x" aria-label="Close">×</button></div>
      <div class="sec"><h4>Label size</h4><div class="statusbar" id="lb-layout">${Object.entries(LABEL_LAYOUTS).map(([k, l]) => `<button type="button" data-l="${k}" aria-pressed="${k === layout}">${esc(l.name)}</button>`).join("")}</div>
        <p class="hint" style="margin:0">${esc(LABEL_LAYOUTS[layout].note)}</p></div>
      <div class="sec"><h4>Preview${items.length > show.length ? ` (first ${show.length})` : ""}</h4><div class="lbl-preview ${layout}">${show.map(labelHtml).join("")}</div></div>
      <div class="sec"><button type="button" class="btn primary big" id="lb-print">Print ${items.length} label${items.length === 1 ? "" : "s"}</button>
        <p class="hint" style="margin:0">Scanning a label with the app's Scan button, or with the phone's own camera, opens that record.</p></div>`, "labels", () => {
      $("lb-layout").onclick = (e) => { const b = e.target.closest("[data-l]"); if (!b) return; layout = b.dataset.l; store.set("cc-label", layout); render(); };
      $("lb-print").onclick = () => printLabels(items, layout);
    });
  };
  render();
}
function printLabels(items, layout) {
  if (window.CC_DEMO) { toast("The demo can only preview labels. Printing works in the live app."); return; }
  const area = $("print-area");
  area.className = "print-" + layout;
  if (layout === "avery") {   // 30 per Letter page: 3 across, 10 down
    const pages = []; for (let k = 0; k < items.length; k += 30) pages.push(items.slice(k, k + 30));
    area.innerHTML = pages.map((pg) => `<div class="avery-page">${pg.map(labelHtml).join("")}</div>`).join("");
  } else area.innerHTML = items.map(labelHtml).join("");
  $("print-size").textContent = layout === "avery"
    ? "@page{size:letter;margin:0}"
    : "@page{size:2.25in 1.25in;margin:0}";
  // The "printing" class only changes what prints, never the screen, so it stays until the person
  // next taps or types (some browsers report printing finished before the page is captured).
  document.body.classList.add("printing");
  const done = () => { document.body.classList.remove("printing"); area.innerHTML = ""; ["pointerdown", "keydown"].forEach((ev) => window.removeEventListener(ev, done, true)); };
  setTimeout(() => { try { window.print(); } catch {} setTimeout(() => ["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, done, true)), 800); }, 50);
}

/* ---------- links from a scanned label: …/#tag=CC-… opens the record ---------- */
function openFromHash() {
  const m = location.hash.match(/^#tag=([A-Za-z0-9-]+)/); if (!m || !D.me) return;
  const it = itemByTag(decodeURIComponent(m[1]));
  history.replaceState(null, "", location.pathname + location.search);
  if (it) { setTab("inventory"); openItem(it.id); } else toast(`No record with tag ${esc(m[1])}.`, true);
}
window.addEventListener("hashchange", openFromHash);

/* ---------- refresh in the background ---------- */
setInterval(() => {
  if (document.hidden || !D.me || $("app").hidden) return;
  const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
  if (!$("sheet").hidden) return;
  load().then(() => { if (tab === "inventory") renderInv(); if (tab === "customers") renderCust(); if (tab === "serials") renderSerials(); }).catch(() => {});
}, 30000);

/* ---------- boot ---------- */
async function boot() {
  try {
    const me = await api("/me", { auth: true });
    if (!me || !me.user) throw 0;
  } catch (e) {
    try { const r = await fetch("/api/me", { credentials: "same-origin" }); const d = await r.json(); showLogin(d.needsSetup); } catch { showLogin(false); }
    return;
  }
  lastSync = "";
  await load(true);
  $("login").hidden = true; $("app").hidden = false;
  setTab(store.get("cc-tab") || "receive");
  openFromHash();
}
boot();
})();

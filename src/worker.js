// CC Medical Inventory — Cloudflare Worker API
// Static page lives in /public; everything under /api/ is handled here.

const SESSION_DAYS = 30;
const MAX_FAILED = 5;          // failed logins before a lockout
const LOCK_MINUTES = 10;
// Password hashing strength (PBKDF2 rounds). Set PBKDF2_ITERATIONS in wrangler.toml:
// 20000 while testing on the Workers Free plan (its 10 ms CPU limit; 100000 takes ~18 ms),
// 100000 (Workers' maximum) once on Workers Paid. Each stored hash records its own rounds,
// and a password is re-hashed at the new strength the next time that person signs in.
const PBKDF2_MAX = 100000;
const PBKDF2_DEFAULT = 100000;
const iterationsFor = (env) => {
  const n = parseInt(env && env.PBKDF2_ITERATIONS, 10);
  return Number.isFinite(n) && n >= 10000 && n <= PBKDF2_MAX ? n : PBKDF2_DEFAULT;
};

export const STATUS = {
  stock: ["In stock", "Pending", "On loan", "Out on rental", "Sold / shipped"],
  repair: ["Received", "Evaluating", "Awaiting approval", "In repair", "Ready to return", "Returned"],
  return: ["Received", "Inspecting", "Back in stock", "Credit issued", "Closed"],
  core: ["Received", "Inspecting", "Credit approved", "Credit denied", "Closed"],
};
const KINDS = Object.keys(STATUS);
const NEEDS_CUSTOMER = ["repair", "return", "core"];
const ISSUE_OPTION = { repair: "problem", return: "reason" };   // what the tap-all-that-apply step stores
const KIND_LABEL = { stock: "New stock", repair: "Customer repair", return: "Customer return", core: "Core return" };
const RECEIVED_TEXT = { stock: "Received into stock", repair: "Received for repair", return: "Customer return received", core: "Core return received" };
const OPTION_KINDS = ["category", "condition", "manufacturer", "model", "location", "problem", "reason"];

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers } });
const nowIso = () => new Date().toISOString();
// Cost: dollars, or null when unknown. Accepts "1,200", "$1200.50".
const money = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 10000000) fail(400, "Cost must be a dollar amount.");
  return Math.round(n * 100) / 100;
};
// Date of manufacture: "YYYY-MM" or "YYYY".
const domStr = (v) => {
  const t = String(v ?? "").trim();
  if (!t) return "";
  if (!/^(19|20)\d\d(-(0[1-9]|1[0-2]))?$/.test(t)) fail(400, "Date of manufacture should look like 2024-08 or 2024.");
  return t;
};
const str = (v, max = 500) => (v == null ? "" : String(v)).trim().slice(0, max);

/* ---------- crypto helpers ---------- */
const enc = new TextEncoder();
const b64e = (u8) => btoa(String.fromCharCode(...u8));
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
// Stored as "<rounds>$<base64 hash>". A hash with no "$" predates this format and used 100000 rounds.
async function hashPassword(password, saltB64, iterations) {
  const salt = saltB64 ? b64d(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { hash: `${iterations}$${b64e(new Uint8Array(bits))}`, salt: b64e(salt) };
}
const roundsOf = (stored) => (String(stored).includes("$") ? parseInt(String(stored).split("$")[0], 10) : 100000);
async function checkPassword(password, user) {
  const { hash } = await hashPassword(password, user.pw_salt, roundsOf(user.pw_hash));
  return sameString(String(user.pw_hash).includes("$") ? hash : hash.split("$")[1], user.pw_hash);
}
function sameString(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const sha256 = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
function newTag() {
  const d = new Date();
  const ymd = String(d.getUTCFullYear()).slice(2) + String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
  const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(4));
  return "CC-" + ymd + "-" + [...r].map((x) => a[x % a.length]).join("");
}
const newId = () => "c_" + hex(crypto.getRandomValues(new Uint8Array(8)));

/* ---------- sessions ---------- */
function cookieToken(req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)ccsid=([a-f0-9]{64})/);
  return m ? m[1] : null;
}
function sessionCookie(token, req, maxAge) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `ccsid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}
async function currentUser(req, env) {
  const token = cookieToken(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).bind(await sha256(token)).first();
  if (!row || !row.active || row.expires_at < nowIso()) return null;
  return { id: row.id, username: row.username, name: row.name, role: row.role };
}
async function startSession(env, req, userId) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(nowIso()),
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).bind(await sha256(token), userId, expires),
  ]);
  return sessionCookie(token, req, SESSION_DAYS * 86400);
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: !!u.active });

function validNewPassword(pw) {
  if (pw.length < 8) fail(400, "Passwords need at least 8 characters.");
}
function validUsername(u) {
  if (!/^[a-zA-Z0-9._-]{2,40}$/.test(u)) fail(400, "Usernames use 2–40 letters, numbers, dots, dashes or underscores.");
}

/* ---------- options ---------- */
function optionStmts(env, pairs) {
  const t = nowIso();
  return pairs
    .filter(([, v]) => v)
    .map(([kind, value, parent = ""]) =>
      env.DB.prepare(`INSERT OR IGNORE INTO options (kind, value, parent, created_at) VALUES (?, ?, ?, ?)`).bind(kind, value, parent, t));
}

/* ---------- serial registry ---------- */
// Insert or refresh a unit's registry row. inc = 1 when this is a new intake of the unit.
function serialUpsert(env, s, t, itemId, inc) {
  const keep = (f) => `${f} = CASE WHEN excluded.${f} <> '' THEN excluded.${f} ELSE serials.${f} END`;
  return env.DB.prepare(`INSERT INTO serials (serial, manufacturer, model, part_number, category, dom, times_received, first_seen, last_seen, last_item_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(serial) DO UPDATE SET ${["manufacturer", "model", "part_number", "category", "dom"].map(keep).join(", ")},
        times_received = serials.times_received + ?, last_seen = excluded.last_seen, last_item_id = excluded.last_item_id`)
    .bind(s.serial, s.manufacturer || "", s.model || "", s.part_number || "", s.category || "", s.dom || "", inc, t, t, itemId, inc);
}

/* ---------- router ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);
    try {
      return await api(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};

async function api(req, env, url) {
  const ITER = iterationsFor(env);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  let body = {};
  if (method !== "GET" && method !== "HEAD") {
    // JSON-only writes block cross-site form posts.
    if (!(req.headers.get("content-type") || "").includes("application/json")) fail(415, "Send JSON.");
    try { body = await req.json(); } catch { fail(400, "That request wasn't valid JSON."); }
    if (!body || typeof body !== "object") body = {};
  }

  /* ----- public routes ----- */
  if (path === "/api/me" && method === "GET") {
    const user = await currentUser(req, env);
    if (user) return json({ user });
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    return json({ user: null, needsSetup: !n || n.n === 0 }, 401);
  }

  if (path === "/api/setup" && method === "POST") {
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first();
    if (n && n.n > 0) fail(403, "Setup is already done. Sign in instead.");
    const username = str(body.username, 40), name = str(body.name, 80) || username, password = String(body.password || "");
    validUsername(username); validNewPassword(password);
    const { hash, salt } = await hashPassword(password, null, ITER);
    const r = await env.DB.prepare(`INSERT INTO users (username, name, role, pw_hash, pw_salt, created_at) VALUES (?, ?, 'admin', ?, ?, ?)`)
      .bind(username, name, hash, salt, nowIso()).run();
    const cookie = await startSession(env, req, r.meta.last_row_id);
    return json({ user: { id: r.meta.last_row_id, username, name, role: "admin" } }, 200, { "set-cookie": cookie });
  }

  if (path === "/api/login" && method === "POST") {
    const username = str(body.username, 40), password = String(body.password || "");
    const u = await env.DB.prepare(`SELECT * FROM users WHERE username = ?`).bind(username).first();
    const badLogin = () => fail(401, "That username and password don't match.");
    if (!u || !u.active) { await hashPassword(password, null, ITER); badLogin(); }
    if (u.locked_until && u.locked_until > nowIso()) fail(429, `Too many tries. Wait ${LOCK_MINUTES} minutes and try again.`);
    if (!(await checkPassword(password, u))) {
      const failed = u.failed + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 6e4).toISOString() : null;
      await env.DB.prepare(`UPDATE users SET failed = ?, locked_until = ? WHERE id = ?`).bind(lock ? 0 : failed, lock, u.id).run();
      badLogin();
    }
    if (roundsOf(u.pw_hash) !== ITER) {
      // Strength setting changed since this password was saved: re-hash it now, while we have it.
      const n = await hashPassword(password, null, ITER);
      await env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, failed = 0, locked_until = NULL WHERE id = ?`).bind(n.hash, n.salt, u.id).run();
    } else {
      await env.DB.prepare(`UPDATE users SET failed = 0, locked_until = NULL WHERE id = ?`).bind(u.id).run();
    }
    const cookie = await startSession(env, req, u.id);
    return json({ user: { id: u.id, username: u.username, name: u.name, role: u.role } }, 200, { "set-cookie": cookie });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = cookieToken(req);
    if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", req, 0) });
  }

  /* ----- everything below needs a signed-in user ----- */
  const me = await currentUser(req, env);
  if (!me) fail(401, "Please sign in.");
  const isAdmin = me.role === "admin";
  // Two roles: admin (also adds and removes user access) and standard (everything else).
  const adminOnly = () => { if (!isAdmin) fail(403, "Only an admin can add or remove access."); };
  const who = me.name || me.username;
  // Item history line, mirrored into the permanent serial log when the item has a serial number.
  const log = (itemId, t, what, serial, kind) => [
    env.DB.prepare(`INSERT INTO history (item_id, at, by, what) VALUES (?,?,?,?)`).bind(itemId, t, who, what),
    ...(serial ? [env.DB.prepare(`INSERT INTO serial_events (serial, at, by, item_id, kind, what) VALUES (?,?,?,?,?,?)`).bind(serial, t, who, itemId, kind || "", what)] : []),
  ];

  // Everything the app shows. With ?since=<time from a previous reply>, only what changed after it.
  if (path === "/api/data" && method === "GET") {
    const since = str(url.searchParams.get("since"), 40);
    const now = nowIso();
    const itemSql = `SELECT i.*, c.name AS customer_name FROM items i LEFT JOIN customers c ON c.id = i.customer_id`;
    const serialSql = `SELECT * FROM serials`;
    if (since && /^\d{4}-\d\d-\d\dT/.test(since)) {
      const [items, customers, options, serials, gone] = await env.DB.batch([
        env.DB.prepare(`${itemSql} WHERE i.updated_at > ? ORDER BY i.updated_at DESC`).bind(since),
        env.DB.prepare(`SELECT * FROM customers WHERE updated_at > ?`).bind(since),
        env.DB.prepare(`SELECT id, kind, value, parent FROM options WHERE created_at > ?`).bind(since),
        env.DB.prepare(`${serialSql} WHERE last_seen > ?`).bind(since),
        env.DB.prepare(`SELECT kind, ref FROM deletions WHERE at > ?`).bind(since),
      ]);
      return json({ full: false, now, items: items.results, customers: customers.results, options: options.results, serials: serials.results, deleted: gone.results, me });
    }
    const [items, customers, options, serials] = await env.DB.batch([
      env.DB.prepare(`${itemSql} ORDER BY i.updated_at DESC`),
      env.DB.prepare(`SELECT * FROM customers ORDER BY name COLLATE NOCASE`),
      env.DB.prepare(`SELECT id, kind, value, parent FROM options ORDER BY value COLLATE NOCASE`),
      env.DB.prepare(`${serialSql} ORDER BY last_seen DESC`),
    ]);
    return json({ full: true, now, items: items.results, customers: customers.results, options: options.results, serials: serials.results, status: STATUS, me });
  }

  /* ----- one unit's full story by serial number ----- */
  if (path === "/api/serial" && method === "GET") {
    const s = str(url.searchParams.get("s"), 120);
    if (!s) fail(400, "Enter a serial number.");
    const [row, items, hist] = await env.DB.batch([
      env.DB.prepare(`SELECT * FROM serials WHERE serial = ?`).bind(s),
      env.DB.prepare(`SELECT i.*, c.name AS customer_name FROM items i LEFT JOIN customers c ON c.id = i.customer_id WHERE i.serial = ? COLLATE NOCASE ORDER BY i.received_at DESC`).bind(s),
      env.DB.prepare(`SELECT e.at, e.by, e.what, e.item_id, e.kind, (i.id IS NOT NULL) AS item_exists FROM serial_events e LEFT JOIN items i ON i.id = e.item_id WHERE e.serial = ? ORDER BY e.at DESC, e.id DESC LIMIT 500`).bind(s),
    ]);
    const serial = row.results[0] || null;
    if (!serial && !items.results.length) return json({ found: false, serial: s });
    return json({ found: true, serial, items: items.results, history: hist.results });
  }

  if (path === "/api/password" && method === "POST") {
    const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(me.id).first();
    if (!(await checkPassword(String(body.current || ""), u))) fail(400, "Your current password isn't right.");
    const pw = String(body.password || ""); validNewPassword(pw);
    const n = await hashPassword(pw, null, ITER);
    await env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?`).bind(n.hash, n.salt, me.id).run();
    return json({ ok: true });
  }

  /* ----- options (buttons) ----- */
  if (path === "/api/options" && method === "POST") {
    const kind = str(body.kind, 30), value = str(body.value, 80), parent = kind === "model" ? str(body.parent, 80) : "";
    if (!OPTION_KINDS.includes(kind)) fail(400, "Unknown button type.");
    if (!value) fail(400, "Type a name for the new button.");
    if (kind === "model" && !parent) fail(400, "Pick a manufacturer before adding a model.");
    await env.DB.batch(optionStmts(env, [[kind, value, parent]]));
    const row = await env.DB.prepare(`SELECT id, kind, value, parent FROM options WHERE kind = ? AND value = ? AND parent = ?`).bind(kind, value, parent).first();
    return json({ option: row });
  }
  let m = path.match(/^\/api\/options\/(\d+)$/);
  if (m && method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM options WHERE id = ?`).bind(+m[1]),
      env.DB.prepare(`INSERT INTO deletions (kind, ref, at) VALUES ('option', ?, ?)`).bind(String(+m[1]), nowIso()),
    ]);
    return json({ ok: true });
  }

  /* ----- customers ----- */
  const custFields = (b) => ({
    name: str(b.name, 120), type: str(b.type, 60), facility: str(b.facility, 120), phone: str(b.phone, 40),
    email: str(b.email, 120), address: str(b.address, 400), notes: str(b.notes, 2000),
  });
  if (path === "/api/customers" && method === "POST") {
    const c = custFields(body);
    if (!c.name) fail(400, "Add the customer's name.");
    const dup = await env.DB.prepare(`SELECT id FROM customers WHERE name = ? COLLATE NOCASE`).bind(c.name).first();
    if (dup) fail(409, "A customer with that name already exists.");
    const id = newId(), t = nowIso();
    await env.DB.prepare(`INSERT INTO customers (id, name, type, facility, phone, email, address, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .bind(id, c.name, c.type, c.facility, c.phone, c.email, c.address, c.notes, t, t).run();
    return json({ customer: await env.DB.prepare(`SELECT * FROM customers WHERE id = ?`).bind(id).first() });
  }
  m = path.match(/^\/api\/customers\/(c_[a-f0-9]+)$/);
  if (m && method === "PATCH") {
    const c = custFields(body);
    if (!c.name) fail(400, "Add the customer's name.");
    const dup = await env.DB.prepare(`SELECT id FROM customers WHERE name = ? COLLATE NOCASE AND id <> ?`).bind(c.name, m[1]).first();
    if (dup) fail(409, "A customer with that name already exists.");
    const r = await env.DB.prepare(`UPDATE customers SET name=?, type=?, facility=?, phone=?, email=?, address=?, notes=?, updated_at=? WHERE id=?`)
      .bind(c.name, c.type, c.facility, c.phone, c.email, c.address, c.notes, nowIso(), m[1]).run();
    if (!r.meta.changes) fail(404, "That customer no longer exists.");
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    await env.DB.batch([
      env.DB.prepare(`UPDATE items SET customer_id = NULL, updated_at = ? WHERE customer_id = ?`).bind(nowIso(), m[1]),
      env.DB.prepare(`DELETE FROM customers WHERE id = ?`).bind(m[1]),
      env.DB.prepare(`INSERT INTO deletions (kind, ref, at) VALUES ('customer', ?, ?)`).bind(m[1], nowIso()),
    ]);
    return json({ ok: true });
  }

  /* ----- items ----- */
  if (path === "/api/items" && method === "POST") {
    const kind = KINDS.includes(body.kind) ? body.kind : "stock";
    const it = {
      category: str(body.category, 80), cond: str(body.cond, 80), manufacturer: str(body.manufacturer, 80), model: str(body.model, 80), part_number: str(body.part_number, 80),
      cost: money(body.cost), dom: domStr(body.dom),
      serial: str(body.serial, 120), ref: str(body.ref, 80), qty: Math.max(1, Math.min(100000, parseInt(body.qty, 10) || 1)), location: str(body.location, 60),
      customer_id: str(body.customer_id, 40) || null, problems: (Array.isArray(body.problems) ? body.problems : []).map((p) => str(p, 80)).filter(Boolean).join("; "),
      notes: str(body.notes, 2000),
    };
    if (!it.category) fail(400, "Pick a category.");
    if (NEEDS_CUSTOMER.includes(kind) && !it.customer_id) fail(400, "Pick the customer this came from.");
    let custName = "";
    if (it.customer_id) {
      const c = await env.DB.prepare(`SELECT name FROM customers WHERE id = ?`).bind(it.customer_id).first();
      if (!c) fail(400, "That customer no longer exists. Pick another.");
      custName = c.name;
    }
    const name = [it.manufacturer, it.model].filter(Boolean).join(" ") || it.category;
    const status = STATUS[kind][0];
    const t = nowIso();
    let tag;
    for (let tries = 0; tries < 5; tries++) {
      tag = newTag();
      if (!(await env.DB.prepare(`SELECT 1 FROM items WHERE id = ?`).bind(tag).first())) break;
    }
    // A serial seen before: note it on both the old record and the new one.
    const serialStmts = [];
    let seenText = "";
    if (it.serial) {
      const prev = await env.DB.prepare(`SELECT last_item_id, times_received FROM serials WHERE serial = ?`).bind(it.serial).first();
      if (prev) {
        seenText = ` · serial seen ${prev.times_received} time${prev.times_received === 1 ? "" : "s"} before`;
        if (prev.last_item_id) serialStmts.push(env.DB.prepare(`INSERT INTO history (item_id, at, by, what) VALUES (?,?,?,?)`).bind(prev.last_item_id, t, who, `Unit received again as ${tag} (${KIND_LABEL[kind]})`));
      }
      serialStmts.push(serialUpsert(env, { ...it }, t, tag, 1));
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO items (id, kind, name, category, cond, manufacturer, model, part_number, serial, ref, cost, dom, qty, location, customer_id, status, problems, notes, received_by, received_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(tag, kind, name, it.category, it.cond, it.manufacturer, it.model, it.part_number, it.serial, it.ref, it.cost, it.dom, it.qty, it.location, it.customer_id, status, it.problems, it.notes, who, t, t),
      ...log(tag, t, RECEIVED_TEXT[kind] + (custName ? " · " + custName : "") + (it.qty > 1 ? ` · qty ${it.qty}` : "") + seenText, it.serial, kind),
      ...serialStmts,
      ...optionStmts(env, [["category", it.category], ["condition", it.cond], ["manufacturer", it.manufacturer], ["model", it.model, it.manufacturer], ["location", it.location],
        ...(ISSUE_OPTION[kind] ? (body.problems || []).map((p) => [ISSUE_OPTION[kind], str(p, 80)]) : [])]),
    ]);
    return json({ item: { id: tag, name, kind, status } });
  }

  m = path.match(/^\/api\/items\/([A-Z0-9-]{6,30})(\/history|\/checkout)?$/);
  if (m) {
    const id = m[1], sub = m[2] || "";
    const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
    if (!item) fail(404, "That item no longer exists.");

    if (sub === "/history" && method === "GET") {
      const h = await env.DB.prepare(`SELECT at, by, what FROM history WHERE item_id = ? ORDER BY id DESC LIMIT 200`).bind(id).all();
      return json({ history: h.results });
    }

    if (sub === "/checkout" && method === "POST") {
      if (item.kind !== "stock") fail(400, "Only stock items can be checked out.");
      const n = Math.max(1, parseInt(body.qty, 10) || 1);
      if (n > item.qty) fail(400, `Only ${item.qty} on hand.`);
      const status = STATUS.stock.includes(body.status) && body.status !== "In stock" ? body.status : "Sold / shipped";
      let cust = null;
      if (body.customer_id) {
        cust = await env.DB.prepare(`SELECT id, name FROM customers WHERE id = ?`).bind(str(body.customer_id, 40)).first();
        if (!cust) fail(400, "That customer no longer exists.");
      }
      const t = nowIso(), to = cust ? " to " + cust.name : "";
      const stmts = [];
      if (n < item.qty) {
        // Split: the units leaving get their own record so their status and customer are tracked.
        let tag;
        for (let tries = 0; tries < 5; tries++) { tag = newTag(); if (!(await env.DB.prepare(`SELECT 1 FROM items WHERE id = ?`).bind(tag).first())) break; }
        stmts.push(
          env.DB.prepare(`UPDATE items SET qty = qty - ?, updated_at = ? WHERE id = ?`).bind(n, t, id),
          env.DB.prepare(`INSERT INTO items (id, kind, name, category, cond, manufacturer, model, part_number, serial, ref, cost, dom, source, qty, location, customer_id, status, problems, notes, received_by, received_at, updated_at)
            SELECT ?, kind, name, category, cond, manufacturer, model, part_number, serial, ref, cost, dom, source, ?, location, ?, ?, problems, notes, received_by, received_at, ? FROM items WHERE id = ?`)
            .bind(tag, n, cust ? cust.id : item.customer_id, status, t, id),
          ...log(id, t, `${n} moved to ${tag} (${status}${to}); ${item.qty - n} left`, item.serial, item.kind),
          ...log(tag, t, `Split from ${id} · ${status}${to} · qty ${n}`),
        );
        await env.DB.batch(stmts);
        return json({ ok: true, newId: tag });
      }
      await env.DB.batch([
        env.DB.prepare(`UPDATE items SET status = ?, customer_id = COALESCE(?, customer_id), updated_at = ? WHERE id = ?`).bind(status, cust ? cust.id : null, t, id),
        ...log(id, t, `${status}${to}${n > 1 ? " · qty " + n : ""}`, item.serial, item.kind),
      ]);
      return json({ ok: true });
    }

    if (!sub && method === "PATCH") {
      const set = {}, notes = [];
      if ("status" in body) {
        const s = str(body.status, 40);
        if (!STATUS[item.kind].includes(s)) fail(400, "That status doesn't apply to this item.");
        if (s !== item.status) { set.status = s; notes.push("Status → " + s); }
      }
      if ("customer_id" in body) {
        const cid = str(body.customer_id, 40) || null;
        if (NEEDS_CUSTOMER.includes(item.kind) && !cid) fail(400, "This item needs a customer.");
        if (cid !== item.customer_id) {
          let cname = "";
          if (cid) { const c = await env.DB.prepare(`SELECT name FROM customers WHERE id = ?`).bind(cid).first(); if (!c) fail(400, "That customer no longer exists."); cname = c.name; }
          set.customer_id = cid; notes.push(cid ? "Assigned to " + cname : "Customer removed");
        }
      }
      if ("dom" in body) body.dom = domStr(body.dom);
      const textFields = { category: 80, cond: 80, manufacturer: 80, model: 80, part_number: 80, serial: 120, ref: 80, dom: 7, location: 60, notes: 2000, problems: 600 };
      const labels = { category: "category", cond: "condition", manufacturer: "manufacturer", model: "model", part_number: "part number", serial: "serial", ref: "RMA / order #", dom: "date of manufacture", location: "location", notes: "notes", problems: "problems" };
      const edited = [];
      for (const [f, max] of Object.entries(textFields)) {
        if (f in body) { const v = str(body[f], max); if (v !== item[f]) { set[f] = v; edited.push(labels[f]); } }
      }
      if ("cost" in body) { const c = money(body.cost); if (c !== item.cost) { set.cost = c; edited.push("cost"); } }
      if ("qty" in body) { const q = Math.max(0, parseInt(body.qty, 10) || 0); if (q !== item.qty) { set.qty = q; edited.push("quantity"); } }
      if (set.category === "") fail(400, "Category can't be blank.");
      if ("manufacturer" in set || "model" in set) {
        const mf = set.manufacturer ?? item.manufacturer, md = set.model ?? item.model;
        set.name = [mf, md].filter(Boolean).join(" ") || (set.category ?? item.category);
      }
      if (edited.length) notes.push("Edited " + edited.join(", "));
      if (!Object.keys(set).length) return json({ ok: true, unchanged: true });
      set.updated_at = nowIso();
      const cols = Object.keys(set);
      const after = { ...item, ...set };
      const serialStmts = [];
      if (after.serial && "serial" in set) serialStmts.push(serialUpsert(env, after, set.updated_at, id, 1));
      else if (after.serial && ["manufacturer", "model", "part_number", "category", "dom"].some((f) => f in set))
        serialStmts.push(env.DB.prepare(`UPDATE serials SET manufacturer = ?, model = ?, part_number = ?, category = ?, dom = ? WHERE serial = ? AND last_item_id = ?`)
          .bind(after.manufacturer, after.model, after.part_number, after.category, after.dom, after.serial, id));
      await env.DB.batch([
        ...serialStmts,
        env.DB.prepare(`UPDATE items SET ${cols.map((c) => c + " = ?").join(", ")} WHERE id = ?`).bind(...cols.map((c) => set[c]), id),
        ...log(id, set.updated_at, notes.join(" · "), after.serial, item.kind),
        ...("serial" in set && item.serial ? [env.DB.prepare(`INSERT INTO serial_events (serial, at, by, item_id, kind, what) VALUES (?,?,?,?,?,?)`)
          .bind(item.serial, set.updated_at, who, id, item.kind, after.serial ? `Serial changed to ${after.serial} on ${id}` : `Serial removed from ${id}`)] : []),
        ...optionStmts(env, [["category", set.category], ["condition", set.cond], ["manufacturer", set.manufacturer],
          ["model", set.model, set.manufacturer ?? item.manufacturer], ["location", set.location]]),
      ]);
      return json({ ok: true });
    }

    if (!sub && method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare(`DELETE FROM items WHERE id = ?`).bind(id),
        env.DB.prepare(`INSERT INTO deletions (kind, ref, at) VALUES ('item', ?, ?)`).bind(id, nowIso()),
        ...(item.serial ? [env.DB.prepare(`INSERT INTO serial_events (serial, at, by, item_id, kind, what) VALUES (?,?,?,?,?,?)`).bind(item.serial, nowIso(), who, id, item.kind, `Record ${id} deleted`)] : []),
        // The unit's registry row stays; point it at its next most recent record, if any.
        env.DB.prepare(`UPDATE serials SET last_item_id = (SELECT id FROM items WHERE serial = serials.serial COLLATE NOCASE AND id <> ? ORDER BY received_at DESC LIMIT 1) WHERE last_item_id = ?`).bind(id, id),
        env.DB.prepare(`DELETE FROM history WHERE item_id = ?`).bind(id),
      ]);
      return json({ ok: true });
    }
  }

  /* ----- users (admin) ----- */
  if (path === "/api/users" && method === "GET") {
    adminOnly();
    const r = await env.DB.prepare(`SELECT id, username, name, role, active FROM users ORDER BY name COLLATE NOCASE`).all();
    return json({ users: r.results.map(publicUser) });
  }
  if (path === "/api/users" && method === "POST") {
    adminOnly();
    const username = str(body.username, 40), name = str(body.name, 80) || username, password = String(body.password || "");
    const role = body.role === "admin" ? "admin" : "standard";
    validUsername(username); validNewPassword(password);
    if (await env.DB.prepare(`SELECT 1 FROM users WHERE username = ?`).bind(username).first()) fail(409, "That username is taken.");
    const { hash, salt } = await hashPassword(password, null, ITER);
    await env.DB.prepare(`INSERT INTO users (username, name, role, pw_hash, pw_salt, created_at) VALUES (?,?,?,?,?,?)`).bind(username, name, role, hash, salt, nowIso()).run();
    return json({ ok: true });
  }
  m = path.match(/^\/api\/users\/(\d+)$/);
  if (m && method === "PATCH") {
    adminOnly();
    const uid = +m[1];
    const u = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(uid).first();
    if (!u) fail(404, "That user no longer exists.");
    const stmts = [];
    if ("name" in body) stmts.push(env.DB.prepare(`UPDATE users SET name = ? WHERE id = ?`).bind(str(body.name, 80) || u.username, uid));
    if ("role" in body || "active" in body) {
      const role = "role" in body ? (body.role === "admin" ? "admin" : "standard") : u.role;
      const active = "active" in body ? (body.active ? 1 : 0) : u.active;
      if (uid === me.id && (role !== "admin" || !active)) fail(400, "You can't remove your own admin access.");
      stmts.push(env.DB.prepare(`UPDATE users SET role = ?, active = ? WHERE id = ?`).bind(role, active, uid));
      if (!active) stmts.push(env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid));
    }
    if (body.password) {
      const pw = String(body.password); validNewPassword(pw);
      const n = await hashPassword(pw, null, ITER);
      stmts.push(env.DB.prepare(`UPDATE users SET pw_hash = ?, pw_salt = ?, failed = 0, locked_until = NULL WHERE id = ?`).bind(n.hash, n.salt, uid));
      stmts.push(env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(uid));
    }
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true });
  }

  fail(404, "Not found.");
}

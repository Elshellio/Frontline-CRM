// /opt/crm/index.js
require("dotenv").config();

const fastify = require("fastify")({ logger: true });
fastify.register(require("@fastify/formbody"));
fastify.register(require("@fastify/cookie"), {
  secret: process.env.COOKIE_SECRET || "dev-secret-change-me",
});
fastify.register(require("@fastify/multipart"), {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");

const PORT = Number(process.env.PORT || 3100);
const ADMIN_USER = String(process.env.ADMIN_USER || "admin");
const ADMIN_PASS = String(process.env.ADMIN_PASS || "admin");

// Public logo URL (Shopify CDN)
const LOGO_URL =
  "https://cdn.shopify.com/s/files/1/0990/6195/6953/files/91fad093-dd7f-4932-9f14-fc02763020e9.png?v=1770144024";

const db = new Database("crm.db");
db.pragma("journal_mode = WAL");

const MISSED_CALLS_DB = "/opt/missed-calls/missed_calls.sqlite";
try {
  db.exec(`ATTACH DATABASE '${MISSED_CALLS_DB.replace(/'/g, "''")}' AS mc`);
} catch (err) {
  const msg = String((err && err.message) || err || "");
  if (!msg.includes("already in use")) throw err;
}

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business TEXT DEFAULT '',
  email TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  town TEXT DEFAULT '',
  website TEXT DEFAULT '',
  tags TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS touchpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customerId INTEGER NOT NULL,
  type TEXT NOT NULL,            -- call | email | visit | note
  note TEXT DEFAULT '',
  at INTEGER NOT NULL,
  FOREIGN KEY(customerId) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  full_name TEXT NOT NULL,
  first_name TEXT,
  role TEXT,
  linkedin_url TEXT,
  stage TEXT,
  last_message_sent TEXT,
  next_follow_up_date TEXT,
  status TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_customers (
  employee_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  PRIMARY KEY (employee_id, customer_id),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_employee_customers_customer_id ON employee_customers(customer_id);
CREATE INDEX IF NOT EXISTS idx_employee_customers_employee_id ON employee_customers(employee_id);

CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_town ON customers(town);
CREATE INDEX IF NOT EXISTS idx_touchpoints_customerId ON touchpoints(customerId);
`);

// CRM_TARGET_PIPELINE_V1
const customerColumns = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
function addCustomerColumn(name, sql) {
  if (!customerColumns.includes(name)) db.exec(`ALTER TABLE customers ADD COLUMN ${sql}`);
}
addCustomerColumn("target_status", "target_status TEXT DEFAULT 'new_target'");
addCustomerColumn("lead_source", "lead_source TEXT DEFAULT ''");
addCustomerColumn("lead_industry", "lead_industry TEXT DEFAULT ''");
addCustomerColumn("outreach_status", "outreach_status TEXT DEFAULT ''");
addCustomerColumn("last_contacted_at", "last_contacted_at TEXT DEFAULT ''");
addCustomerColumn("next_follow_up_at", "next_follow_up_at TEXT DEFAULT ''");
addCustomerColumn("replied_at", "replied_at TEXT DEFAULT ''");
addCustomerColumn("pipeline_notes", "pipeline_notes TEXT DEFAULT ''");
db.prepare(`
  UPDATE customers
  SET lead_source = CASE WHEN TRIM(COALESCE(lead_source,'')) = '' THEN 'lead_engine' ELSE lead_source END,
      target_status = CASE WHEN TRIM(COALESCE(target_status,'')) = '' THEN 'new_target' ELSE target_status END,
      outreach_status = CASE WHEN TRIM(COALESCE(outreach_status,'')) = '' THEN 'not_contacted' ELSE outreach_status END,
      lead_industry = CASE
        WHEN TRIM(COALESCE(lead_industry,'')) != '' THEN lead_industry
        WHEN tags LIKE '%garages%' THEN 'Garages / MOT'
        WHEN tags LIKE '%law_firms%' THEN 'Law firms'
        WHEN tags LIKE '%estate_agents%' THEN 'Estate agents'
        WHEN tags LIKE '%restaurants%' THEN 'Restaurants'
        WHEN tags LIKE '%salons%' THEN 'Salons'
        WHEN tags LIKE '%clinics%' THEN 'Clinics'
        WHEN tags LIKE '%locksmiths%' THEN 'Locksmiths'
        ELSE lead_industry
      END
  WHERE tags LIKE '%lead-engine%'
`).run();

function now() {
  return Date.now();
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// CRM_ECOSYSTEM_MENU_V1
function ecosystemMenu(active = "crm-targets", itemClass = "", activeClass = "active") {
  const items = [
    ["dashboard", "🏠 Dashboard", "https://hub.frontline-ai.co.uk/"],
    ["towns", "🗺️ UK Towns Tracker", "http://hub.frontline-ai.co.uk:3116/"],
    ["lead-engine", "🎯 Lead Engine", "https://hub.frontline-ai.co.uk/lead-engine"],
    ["crm-targets", "🗄️ CRM / Targets", "http://hub.frontline-ai.co.uk:3100/targets"],
    ["crm-customers", "👥 CRM / Customers", "http://hub.frontline-ai.co.uk:3100/customers"],
  ];
  return items.map(([key, label, href]) => {
    const cls = [itemClass, key === active ? activeClass : ""].filter(Boolean).join(" ");
    return `<a${cls ? ` class="${esc(cls)}"` : ""} href="${esc(href)}"><span>${esc(label)}</span></a>`;
  }).join("");
}

function hubSidebar(active = "crm-targets") {
  return `
    <aside class="hub-ecosystem-side">
      <div class="hub-ecosystem-brand">
        <div class="hub-ecosystem-mark"><img src="https://hub.frontline-ai.co.uk/fllogo.png" alt="Frontline AI" /></div>
        <div><strong>Frontline AI</strong><span>Hub</span></div>
      </div>
      <nav class="hub-ecosystem-nav">
        ${ecosystemMenu(active)}
      </nav>
    </aside>
  `;
}

// CRM_LEAD_ENGINE_IMPORT_V1
function crmNorm(s) {
  return String(s || "").trim();
}

function crmNormLower(s) {
  return crmNorm(s).toLowerCase();
}

function crmNormWebsite(s) {
  return crmNormLower(s).replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
}

function crmIsLocalRequest(req) {
  const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || (req.raw && req.raw.socket && req.raw.socket.remoteAddress) || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function crmBuildLeadEngineNotes(lead) {
  const lines = [
    "Source: Frontline-Hub Lead Engine",
    lead.lead_id ? `Hub lead id: ${lead.lead_id}` : "",
    lead.industryProfileLabel ? `Profile: ${lead.industryProfileLabel}` : "",
    lead.leadOpportunity ? `Opportunity: ${lead.leadOpportunity}` : "",
    lead.recommendedContactRoute ? `Contact route: ${lead.recommendedContactRoute}` : "",
    lead.salesReason ? `Sales reason: ${lead.salesReason}` : "",
    lead.suggestedOpener ? `Suggested opener: ${lead.suggestedOpener}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

const TARGET_STATUSES = [
  "new_target",
  "ready_to_contact",
  "email_sent",
  "follow_up_due",
  "replied",
  "call_booked",
  "won",
  "lost",
  "not_interested",
  "parked"
];

// CRM_TARGET_SCOPE_FIX_V1: default new_target values should not pull legacy customers into /targets.
const TARGET_SCOPE_SQL = "(COALESCE(target_status,'') != 'archived' AND (lead_source='lead_engine' OR tags LIKE '%lead-engine%' OR (TRIM(COALESCE(target_status,'')) != '' AND target_status != 'new_target')))";

function targetStatusLabel(status) {
  return String(status || "").replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function isTargetCustomer(c) {
  const status = crmNorm(c.target_status);
  if (status === "archived") return false;
  return crmNorm(c.lead_source) === "lead_engine"
    || /\blead-engine\b/i.test(String(c.tags || ""))
    || (!!status && status !== "new_target");
}

function appendPipelineNotes(existing, next) {
  const a = crmNorm(existing);
  const b = crmNorm(next);
  return [a, b].filter(Boolean).join(a && b ? "\n\n" : "");
}

function htmlToText(input){
  let s = String(input||"");
  if (!s) return "";
  if (s.indexOf("<") === -1 && s.indexOf("&") === -1) return s.trim();
  s = s
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/p>/gi,"\n")
    .replace(/<\/div>/gi,"\n")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">")
    .replace(/&quot;/gi,"\"")
    .replace(/&#39;/gi,"'")
    .replace(/[ \t\r]+/g," ")
    .replace(/\n\s*\n\s*\n+/g,"\n\n")
    .trim();
  return s;
}

function layout(title, body, { showLogout } = { showLogout: true }) {
  return `<!doctype html>
<html lang="en">
<head>

<style id="mcr-dark-shell">
body:not(.crm-skin-v2){
  background:
    radial-gradient(circle at top left, rgba(82,71,215,.25), transparent 30%),
    radial-gradient(circle at top right, rgba(0,163,255,.15), transparent 25%),
    linear-gradient(180deg,#07101f 0%,#020712 100%) !important;
  color:#e7eefc !important;
}

body:not(.crm-skin-v2) a{ color:#dbe7ff; }

body:not(.crm-skin-v2) .card,
body:not(.crm-skin-v2) .panel,
body:not(.crm-skin-v2) .box,
body:not(.crm-skin-v2) .table-wrap,
body:not(.crm-skin-v2) table,
body:not(.crm-skin-v2) form,
body:not(.crm-skin-v2) .content,
body:not(.crm-skin-v2) .wrap > div,
body:not(.crm-skin-v2) .main > div{
  background:linear-gradient(180deg,rgba(15,23,42,.88),rgba(2,6,23,.94)) !important;
  border:1px solid rgba(255,255,255,.08) !important;
  border-radius:18px !important;
  box-shadow:0 20px 50px rgba(0,0,0,.35) !important;
}

body:not(.crm-skin-v2) input,
body:not(.crm-skin-v2) select,
body:not(.crm-skin-v2) textarea{
  background:rgba(255,255,255,.05) !important;
  color:#fff !important;
  border:1px solid rgba(255,255,255,.10) !important;
  border-radius:12px !important;
}

body:not(.crm-skin-v2) select option{
  background:#ffffff !important;
  color:#0f172a !important;
}

body:not(.crm-skin-v2) select optgroup{
  background:#ffffff !important;
  color:#0f172a !important;
}

button, .btn{
  background:linear-gradient(180deg,#ffffff,#e6ebff) !important;
  color:#020617 !important;
  border:1px solid rgba(255,255,255,.08) !important;
  border-radius:12px !important;
  font-weight:700 !important;
}

table{
  border-collapse:separate !important;
  border-spacing:0 !important;
  overflow:hidden !important;
}

th{
  color:#94a3b8 !important;
  text-transform:uppercase !important;
  letter-spacing:.08em !important;
  font-weight:800 !important;
}

td{
  border-top:1px solid rgba(255,255,255,.06) !important;
}

.mcr-top-logo{
  display:flex;
  align-items:center;
  gap:12px;
  margin:0 auto 18px auto;
  max-width:1200px;
  padding:14px 18px;
  border:1px solid rgba(255,255,255,.08);
  border-radius:18px;
  background:linear-gradient(180deg,rgba(9,19,42,.95),rgba(3,11,24,.95));
  box-shadow:0 20px 50px rgba(0,0,0,.35);
}
.mcr-top-logo img{
  width:46px;
  height:46px;
  border-radius:12px;
  box-shadow:0 8px 20px rgba(0,0,0,.4);
}
.mcr-top-logo .t1{
  font-size:12px;
  font-weight:700;
  letter-spacing:.18em;
  text-transform:uppercase;
  color:#94a3b8;
}
.mcr-top-logo .t2{
  font-size:18px;
  font-weight:800;
  color:#fff;
}
</style>

  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${esc(title)}</title>
  <style>
    :root{
      --bg:#09101d;
      --card:rgba(44,68,120,.66);
      --muted:rgba(227,234,255,.72);
      --text:#eef3ff;
      --line:rgba(125,144,255,.16);
      --btn:#3b82f6;
    }
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
    body.crm-skin-v2{
      margin:0;
      color:var(--text);
      background:
        radial-gradient(circle at top left, rgba(98,76,255,.22), transparent 34%),
        radial-gradient(circle at top right, rgba(0,203,255,.14), transparent 24%),
        linear-gradient(180deg, #0a1020 0%, #09101d 100%);
      position:relative;
      overflow-x:hidden;
    }
    body.crm-skin-v2::before{
      content:"";
      position:fixed;
      inset:0;
      background:url("https://cdn.shopify.com/s/files/1/0990/6195/6953/files/logo.jpg?v=1770664808") center center / 62% auto no-repeat;
      opacity:.10;
      filter:blur(36px);
      transform:scale(1.08);
      pointer-events:none;
      z-index:0;
    }
    body.crm-skin-v2::after{
      content:"";
      position:fixed;
      inset:0;
      background:
        radial-gradient(circle at 50% 38%, rgba(72,140,255,.12), transparent 30%),
        radial-gradient(circle at 48% 44%, rgba(255,255,255,.05), transparent 18%);
      pointer-events:none;
      z-index:0;
    }
    .wrap{
      position:relative;
      z-index:1;
    }
    a{color:#cfe0ff;text-decoration:none}
    a:hover{text-decoration:none}
    .wrap{
      max-width:1480px;
      margin:20px auto;
      padding:28px;
    }
    .top{
      display:flex;
      gap:12px;
      align-items:center;
      justify-content:space-between;
      margin-bottom:20px;
      padding:18px 20px;
      border-radius:24px;
      border:1px solid rgba(125,144,255,.16);
      background:
        radial-gradient(circle at top right, rgba(255,255,255,.08), transparent 24%),
        linear-gradient(180deg, rgba(8,14,30,.92), rgba(6,12,26,.96));
      box-shadow:
        0 20px 50px rgba(0,0,0,.30),
        inset 0 1px 0 rgba(255,255,255,.05);
    }
    .ecosystem-bar{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      align-items:center;
      margin:0 0 20px;
      padding:12px;
      border-radius:20px;
      border:1px solid rgba(224,236,255,.18);
      background:linear-gradient(180deg,rgba(15,23,42,.86),rgba(2,6,23,.92));
      box-shadow:0 18px 44px rgba(0,0,0,.24), inset 0 1px 0 rgba(255,255,255,.06);
    }
    .ecosystem-bar a{
      display:inline-flex;
      align-items:center;
      min-height:38px;
      padding:0 14px;
      border-radius:12px;
      color:#eef5ff;
      font-size:13px;
      font-weight:850;
      background:rgba(255,255,255,.045);
      border:1px solid rgba(255,255,255,.08);
    }
    .ecosystem-bar a.active{
      color:#07101f;
      background:linear-gradient(180deg,#ffffff,#e6ebff);
      border-color:rgba(255,255,255,.35);
    }
    .hub-ecosystem-layout{
      display:grid;
      grid-template-columns:250px minmax(0,1fr);
      gap:0;
      align-items:start;
      min-height:100vh;
    }
    .hub-ecosystem-side{
      position:sticky;
      top:0;
      height:100vh;
      padding:24px 18px;
      border-right:1px solid rgba(255,255,255,.09);
      background:linear-gradient(180deg,rgba(7,17,31,.96),rgba(3,9,18,.92));
      border-radius:0;
    }
    .hub-ecosystem-brand{
      display:flex;
      align-items:center;
      gap:12px;
      margin-bottom:28px;
      padding:12px 10px;
      border:1px solid rgba(255,255,255,.09);
      border-radius:18px;
      background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));
    }
    .hub-ecosystem-mark{
      width:46px;
      height:46px;
      display:grid;
      place-items:center;
      border-radius:14px;
      background:linear-gradient(180deg,#0d1930,#09111f);
      border:1px solid rgba(255,255,255,.08);
      overflow:hidden;
      flex:0 0 46px;
    }
    .hub-ecosystem-mark img{
      width:100%;
      height:100%;
      object-fit:contain;
      display:block;
    }
    .hub-ecosystem-brand strong{display:block;font-size:17px;color:#fff}
    .hub-ecosystem-brand span{display:block;color:#d8ad4c;font-size:12px;letter-spacing:.12em;text-transform:uppercase}
    .hub-ecosystem-nav{
      display:grid;
      gap:8px;
    }
    .hub-ecosystem-nav a{
      display:block;
      padding:12px 13px;
      border-radius:14px;
      text-decoration:none;
      color:#c8d2e2;
      border:1px solid transparent;
      font-weight:500;
    }
    .hub-ecosystem-nav a.active{
      background:linear-gradient(135deg,rgba(216,173,76,.22),rgba(216,173,76,.08));
      border-color:rgba(216,173,76,.45);
      color:#fff;
    }
    @media(max-width:1000px){
      .hub-ecosystem-layout{grid-template-columns:1fr}
      .hub-ecosystem-side{position:relative;min-height:auto;border-right:0}
    }
    .brand{display:flex;gap:12px;align-items:center}
    .brand img{
      height:58px;
      width:auto;
      display:block;
      border-radius:14px;
      box-shadow:0 10px 26px rgba(0,0,0,.30);
    }
    .badge{
      padding:8px 12px;
      border:1px solid rgba(255,255,255,.10);
      border-radius:999px;
      color:var(--muted);
      font-size:12px;
      background:rgba(255,255,255,.05);
    }
    .card{
      background:
        radial-gradient(circle at top right, rgba(255,255,255,.14), transparent 28%),
        linear-gradient(180deg, rgba(18,30,62,.54), rgba(10,20,40,.44));
      border:1px solid rgba(194,218,255,.16);
      border-radius:22px;
      padding:18px;
      backdrop-filter:blur(18px);
      -webkit-backdrop-filter:blur(18px);
      box-shadow:
        0 18px 40px rgba(0,0,0,.24),
        inset 0 1px 0 rgba(255,255,255,.08);
    }
    .grid{display:grid;grid-template-columns:1fr;gap:16px}
    @media(min-width:900px){.grid{grid-template-columns:1.3fr 0.7fr}}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .btn{
      display:inline-block;
      background:linear-gradient(180deg, rgba(72,126,255,.96), rgba(48,92,231,.96));
      color:#fff;
      border:none;
      border-radius:999px;
      padding:10px 16px;
      font-weight:700;
      cursor:pointer;
      box-shadow:
        0 10px 24px rgba(40,86,220,.28),
        inset 0 1px 0 rgba(255,255,255,.14);
    }
    .btn.secondary{
      background:rgba(255,255,255,.04);
      border:1px solid rgba(255,255,255,.10);
      color:var(--text);
      box-shadow:inset 0 1px 0 rgba(255,255,255,.04);
    }
    input,textarea,select{
      width:100%;
      padding:11px 13px;
      border-radius:14px;
      border:1px solid var(--line);
      background:#0e1522;
      color:var(--text);
    }
    textarea{min-height:120px}
    label{font-size:12px;color:var(--muted);display:block;margin:10px 0 6px}
    table{width:100%;border-collapse:collapse}
    th,td{
      border-bottom:1px solid rgba(255,255,255,.08);
      padding:10px 6px;
      text-align:left;
      font-size:14px;
      vertical-align:top
    }
    th{color:var(--muted);font-size:12px;font-weight:600}
    .muted{color:var(--muted)}
    .pill{
      display:inline-block;
      border:1px solid rgba(255,255,255,.10);
      border-radius:999px;
      padding:5px 9px;
      font-size:12px;
      color:var(--muted);
      background:rgba(255,255,255,.04);
    }
    .right{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    .err{
      border:1px solid #7f1d1d;
      background:#2a1111;
      color:#fecaca;
      padding:10px 12px;
      border-radius:14px;
      margin-bottom:12px
    }
    code{
      background:#0e1522;
      border:1px solid var(--line);
      padding:2px 6px;
      border-radius:8px
    }
  </style>
</head>
<body class="crm-skin-v2">
  <div class="wrap">
    <div class="top">
      <div class="brand">
        <img src="${esc(LOGO_URL)}" alt="Missed Calls Recovered" />
        <div class="badge">Customer CRM</div>
      </div>
      ${
        showLogout
          ? `<div class="row" style="justify-content:flex-end">
               <a class="btn secondary" href="/customers">Customers</a>
               <a class="btn secondary" href="/employees">Employees</a>
               <a class="btn secondary" href="/outbound/openers">Openers</a>
               <a class="btn secondary" href="/customers/import">Bulk upload</a>
               <form method="post" action="/logout" style="margin:0">
                 <button class="btn secondary" type="submit">Logout</button>
               </form>
             </div>`
          : `<div></div>`
      }
    </div>
    ${body}
  </div>
</body>
</html>`;
}

async function ensureAdminHash() {
  const saltRounds = 12;
  const hash = await bcrypt.hash(ADMIN_PASS, saltRounds);
  return hash;
}
let ADMIN_HASH_PROMISE = ensureAdminHash();

function isAuthed(req) {
  return req.cookies && req.cookies.crm_auth === "1";
}

function requireAuth(req, reply) {
  if (!isAuthed(req)) {
    reply.redirect("/login");
    return false;
  }
  return true;
}

/* =========================
   Simple CSV parser
   ========================= */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inQuotes) {
      if (c === '"' && n === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\r" && n === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every((x) => String(x).trim() === "")) {
    rows.pop();
  }

  return rows;
}

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replaceAll(" ", "")
    .replaceAll("_", "");
}

fastify.get("/", async (req, reply) => {
  if (!isAuthed(req)) return reply.redirect("/login");
  return reply.redirect("/customers");
});

fastify.get("/login", async (req, reply) => {
  const e = req.query && req.query.e ? String(req.query.e) : "";
  return reply.type("text/html").send(layout("Login", `
    <div class="card" style="max-width:460px;margin:40px auto">
      <h1>CRM Login</h1>
      ${e ? `<div class="bad">${esc(e)}</div>` : ""}
      <form method="post" action="/login">
        <label>Username</label>
        <input name="user" autocomplete="username" autofocus>
        <label style="margin-top:10px">Password</label>
        <input name="pass" type="password" autocomplete="current-password">
        <div class="row" style="margin-top:14px;justify-content:flex-end">
          <button type="submit">Login</button>
        </div>
      </form>
    </div>
  `));
});

fastify.post("/login", async (req, reply) => {
  const { user, pass } = req.body || {};
  if (!user || !pass) return reply.redirect("/login?e=Missing%20credentials");
  if (String(user) !== ADMIN_USER) return reply.redirect("/login?e=Invalid%20login");

  const hash = await ADMIN_HASH_PROMISE;
  const ok = await bcrypt.compare(String(pass), hash);
  if (!ok) return reply.redirect("/login?e=Invalid%20login");

  reply.setCookie("crm_auth", "1", {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    maxAge: 60 * 60 * 24 * 30,
  });

  return reply.redirect("/customers");
});

fastify.post("/logout", async (req, reply) => {
  reply.clearCookie("crm_auth", { path: "/" });
  return reply.redirect("/login");
});

fastify.get("/outbound/openers", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const town = String((req.query && req.query.town) || "").trim();

  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:800;font-size:18px">Outbound Openers</div>
        <div class="muted">Search by town, expand restaurants, tick contacts, and add selected contacts into the opener queue.</div>
      </div>
      <div class="row">
        <a class="btn secondary" href="/customers">Back to customers</a>
      </div>
    </div>

    <form id="openersSearchForm" style="margin-top:12px">
      <div class="row">
        <div style="flex:1;min-width:220px">
          <label>Town</label>
          <input id="townInput" name="town" value="${esc(town)}" placeholder="e.g. Bristol" />
        </div>
        <div style="align-self:flex-end;display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn secondary" type="submit">Search</button>
          <button class="btn" type="button" id="addSelectedBtn">Add selected to openers</button>
        </div>
      </div>
    </form>

    <div id="openersStatus" class="muted" style="margin-top:14px">Enter a town and search.</div>
    <div id="openersResults" style="margin-top:14px"></div>
  </div>

  <script>
    const form = document.getElementById("openersSearchForm");
    const townInput = document.getElementById("townInput");
    const resultsEl = document.getElementById("openersResults");
    const statusEl = document.getElementById("openersStatus");
    const addBtn = document.getElementById("addSelectedBtn");

    function escHtml(v){
      return String(v ?? "")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
    }

    function renderResults(data){
      const results = Array.isArray(data && data.results) ? data.results : [];
      if (!results.length) {
        resultsEl.innerHTML = "";
        statusEl.textContent = data && data.town
          ? "No opener candidates found for " + data.town + "."
          : "No opener candidates found.";
        return;
      }

      statusEl.textContent = results.length + " restaurants found for " + (data.town || "") + ".";

      resultsEl.innerHTML = results.map((r, idx) => {
        const primary = r.contacts && r.contacts.length
          ? r.contacts[r.primary_contact_index >= 0 ? r.primary_contact_index : 0]
          : null;

        const primaryText = primary
          ? (primary.contact_name ? primary.contact_name + " • " : "") + primary.email + " • " + primary.contact_type
          : "No contact";

        const contactsHtml = (r.contacts || []).map((c, i) => {
          const contactLabel = c.contact_name
            ? escHtml(c.contact_name) + ' <span class="muted">(' + escHtml(c.contact_type) + ')</span>'
            : '<span style="font-weight:700">' + escHtml(c.email) + '</span> <span class="muted">(' + escHtml(c.contact_type) + ')</span>';

          const secondary = c.contact_name
            ? '<div class="muted" style="font-size:12px;margin-top:2px">' + escHtml(c.email) + '</div>'
            : '';

          const checked = i === (r.primary_contact_index >= 0 ? r.primary_contact_index : 0) ? 'checked' : '';

          return (
            '<label style="display:flex;gap:12px;align-items:flex-start;padding:10px 12px;border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.03)">' +
            '<input type="checkbox" class="opener-contact" ' +
            'data-customer-id="' + escHtml(r.customer_id) + '" ' +
            'data-contact-type="' + escHtml(c.contact_type) + '" ' +
            'data-employee-id="' + escHtml(c.employee_id == null ? "" : c.employee_id) + '" ' +
            (i === (r.primary_contact_index >= 0 ? r.primary_contact_index : 0) ? 'checked ' : '') +
            'style="width:18px;height:18px;margin-top:2px" />' +
            '<div>' +
            '<div style="font-weight:700">' + contactLabel + '</div>' +
            secondary +
            '</div>' +
            '</label>'
          );
        }).join("");

        return (
          '<div class="card" style="margin-top:' + (idx === 0 ? 0 : 14) + 'px;padding:16px">' +
            '<div class="row" style="justify-content:space-between;align-items:flex-start;gap:16px">' +
              '<div>' +
                '<div style="font-size:18px;font-weight:800">' + escHtml(r.restaurant_name) + '</div>' +
                '<div class="muted" style="margin-top:4px">' + escHtml(r.town || "") + '</div>' +
                '<div style="margin-top:8px">' +
                  '<span class="pill">Primary: ' + escHtml(primaryText) + '</span>' +
                  '<span class="pill">' + escHtml(String(r.contact_count || 0)) + ' contacts</span>' +
                '</div>' +
              '</div>' +
              '<button class="btn secondary toggle-contacts" type="button" data-target="contacts-' + escHtml(r.customer_id) + '">Show contacts</button>' +
            '</div>' +
            '<div id="contacts-' + escHtml(r.customer_id) + '" style="display:none;margin-top:14px">' +
              '<div style="display:grid;gap:10px">' +
                contactsHtml +
              '</div>' +
            '</div>' +
          '</div>'
        );
      }).join("");

      resultsEl.querySelectorAll(".toggle-contacts").forEach((btn) => {
        btn.addEventListener("click", () => {
          const targetId = btn.getAttribute("data-target");
          const pane = document.getElementById(targetId);
          const isOpen = pane.style.display !== "none";
          pane.style.display = isOpen ? "none" : "block";
          btn.textContent = isOpen ? "Show contacts" : "Hide contacts";
        });
      });
    }

    async function runSearch(ev){
      if (ev) ev.preventDefault();
      const town = String(townInput.value || "").trim();

      if (!town) {
        statusEl.textContent = "Enter a town first.";
        resultsEl.innerHTML = "";
        return;
      }

      statusEl.textContent = "Searching...";
      resultsEl.innerHTML = "";

      const res = await fetch("/api/outbound/openers/search?town=" + encodeURIComponent(town), {
        credentials: "same-origin"
      });

      if (!res.ok) {
        statusEl.textContent = "Search failed.";
        resultsEl.innerHTML = "";
        return;
      }

      const data = await res.json();
      renderResults(data);
    }

    async function addSelected(){
      const selected = Array.from(document.querySelectorAll(".opener-contact:checked")).map((el) => ({
        customer_id: Number(el.getAttribute("data-customer-id") || 0),
        employee_id: el.getAttribute("data-employee-id") ? Number(el.getAttribute("data-employee-id")) : null,
        contact_type: String(el.getAttribute("data-contact-type") || "")
      }));

      if (!selected.length) {
        statusEl.textContent = "No contacts selected.";
        return;
      }

      addBtn.disabled = true;
      addBtn.textContent = "Adding...";
      statusEl.textContent = "Adding selected contacts to openers...";

      try {
        const res = await fetch("/api/outbound/openers/add", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ selections: selected })
        });

        const data = await res.json();

        if (!res.ok || !data.ok) {
          statusEl.textContent = "Add failed.";
          return;
        }

        statusEl.textContent =
          "Added " + data.inserted_count + " contact(s). Skipped " + data.skipped_count + ".";
        await runSearch();
      } catch (err) {
        statusEl.textContent = "Add failed.";
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = "Add selected to openers";
      }
    }

    form.addEventListener("submit", runSearch);
    addBtn.addEventListener("click", addSelected);

    if (townInput.value.trim()) {
      runSearch();
    }
  </script>
  `;

  return reply.type("text/html").send(layout("Outbound Openers", body));
});

fastify.get("/customers", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const q = String((req.query && req.query.q) || "").trim();
  const town = String((req.query && req.query.town) || "").trim();
  const tag = String((req.query && req.query.tag) || "").trim();
  const selectedId = Number((req.query && req.query.selected) || 0);

  let where = "1=1";
  const params = {};

  if (q) {
    where += " AND (name LIKE @q OR business LIKE @q OR email LIKE @q OR phone LIKE @q OR website LIKE @q OR town LIKE @q OR tags LIKE @q OR notes LIKE @q)";
    params.q = `%${q}%`;
  }
  if (town) {
    where += " AND town LIKE @town";
    params.town = `%${town}%`;
  }
  if (tag) {
    where += " AND tags LIKE @tag";
    params.tag = `%${tag}%`;
  }

  const shouldSearchCustomers = !!(q || town || tag);
  const rows = !shouldSearchCustomers
    ? []
    : db.prepare(`
    SELECT
      c.*,
      (SELECT COUNT(1) FROM employee_customers ec WHERE ec.customer_id = c.id) AS employee_count
    FROM customers c
    WHERE ${where}
    ORDER BY updatedAt DESC
    LIMIT 500
  `).all(params);

  const stats = {
    total: db.prepare(`SELECT COUNT(1) AS n FROM customers`).get().n,
    withEmail: db.prepare(`SELECT COUNT(1) AS n FROM customers WHERE TRIM(COALESCE(email,'')) != ''`).get().n,
    withEmployees: db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM employee_customers`).get().n,
    needsAttention: db.prepare(`
      SELECT COUNT(1) AS n
      FROM customers c
      WHERE TRIM(COALESCE(c.email,'')) = ''
        AND NOT EXISTS (
          SELECT 1 FROM employee_customers ec WHERE ec.customer_id = c.id
        )
    `).get().n
  };

  const selected =
    (selectedId ? rows.find(r => Number(r.id) === selectedId) : null) ||
    rows[0] ||
    null;

  let selectedFresh = null;
  let selectedEmployees = [];
  let latestTouchpoint = null;

  if (selected) {
    selectedFresh = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(selected.id);
    selectedEmployees = db.prepare(`
      SELECT e.*
      FROM employees e
      JOIN employee_customers ec ON ec.employee_id = e.id
      WHERE ec.customer_id = ?
      ORDER BY datetime(e.updated_at) DESC, e.full_name ASC
    `).all(selected.id);

    latestTouchpoint = db.prepare(`
      SELECT *
      FROM touchpoints
      WHERE customerId = ?
      ORDER BY at DESC
      LIMIT 1
    `).get(selected.id);
  }

  const allTowns = db.prepare(`
    SELECT town, COUNT(1) AS count
    FROM customers
    WHERE TRIM(COALESCE(town,'')) != ''
    GROUP BY town
    ORDER BY count DESC, town ASC
    LIMIT 12
  `).all();

  function makeCustomerHref(customerId) {
    const qp = new URLSearchParams();
    if (q) qp.set("q", q);
    if (town) qp.set("town", town);
    if (tag) qp.set("tag", tag);
    qp.set("selected", String(customerId));
    return `/customers?${qp.toString()}`;
  }

  function safeWebHref(web) {
    const v = String(web || "").trim();
    if (!v) return "";
    return /^https?:\/\//i.test(v) ? v : `https://${v}`;
  }

  const body = `
  <style>
    .top{display:none}
    .wrap{max-width:none!important;margin:0!important;padding:0!important}
    .crm-v1-shell{
      display:grid;
      grid-template-columns:250px minmax(0,1fr);
      gap:0;
      align-items:start;
      min-height:100vh;
    }
    .crm-v1-side{
      position:sticky;
      top:22px;
      display:flex;
      flex-direction:column;
      gap:16px;
    }
    .crm-v1-sidecard{
      border:1px solid rgba(224,236,255,.28);
      border-radius:28px;
      padding:18px;
      background:
        radial-gradient(circle at top right, rgba(255,255,255,.24), transparent 30%),
        linear-gradient(180deg, rgba(40,66,118,.46), rgba(24,42,82,.32));
      backdrop-filter:blur(20px);
      -webkit-backdrop-filter:blur(20px);
      box-shadow:0 24px 60px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.12);
    }
    .crm-v1-brand{
      display:flex;
      align-items:center;
      gap:14px;
      margin-bottom:8px;
    }
    .crm-v1-brand img{
      width:56px;
      height:56px;
      border-radius:18px;
      object-fit:cover;
      box-shadow:0 12px 28px rgba(0,0,0,.35);
    }
    .crm-v1-brand-title{
      font-size:30px;
      font-weight:800;
      line-height:1.05;
      letter-spacing:-.03em;
      color:#f8fbff;
    }
    .crm-v1-brand-sub{
      color:rgba(226,235,255,.72);
      font-size:13px;
      margin-top:4px;
    }
    .crm-v1-nav{
      display:grid;
      gap:10px;
      margin-top:12px;
    }
    .crm-v1-nav-label{
      margin:16px 4px 0;
      color:rgba(226,235,255,.58);
      font-size:11px;
      font-weight:800;
      letter-spacing:.10em;
      text-transform:uppercase;
    }
    .crm-v1-nav a,
    .crm-v1-nav .muted-link{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      padding:13px 14px;
      border-radius:18px;
      color:#ecf3ff;
      background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.06);
      font-weight:700;
    }
    .crm-v1-nav a.active{
      background:linear-gradient(180deg, rgba(66,123,255,.20), rgba(35,83,210,.16));
      border-color:rgba(102,147,255,.40);
      box-shadow:0 12px 28px rgba(32,78,214,.22);
    }
    .crm-v1-nav .muted-link{
      color:rgba(231,239,255,.56);
    }
    .crm-v1-main{
      display:grid;
      gap:18px;
      padding:32px 32px 40px;
      max-width:1500px;
      width:100%;
    }
    .crm-v1-header{
      border:1px solid rgba(224,236,255,.28);
      border-radius:28px;
      padding:18px 22px;
      background:
        radial-gradient(circle at 78% 14%, rgba(112,184,255,.24), transparent 28%),
        radial-gradient(circle at 12% 0%, rgba(114,95,255,.22), transparent 30%),
        linear-gradient(135deg, rgba(40,66,118,.42), rgba(26,48,96,.30));
      backdrop-filter:blur(20px);
      -webkit-backdrop-filter:blur(20px);
      box-shadow:0 24px 60px rgba(0,0,0,.22), inset 0 1px 0 rgba(255,255,255,.12);
    }
    .crm-v1-header-top{
      display:flex;
      gap:16px;
      align-items:flex-start;
      justify-content:space-between;
      flex-wrap:wrap;
    }
    .crm-v1-hero{
      max-width:760px;
    }
    .crm-v1-eyebrow{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:8px 12px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.10);
      background:rgba(255,255,255,.05);
      color:#d9e6ff;
      font-size:12px;
      font-weight:800;
      letter-spacing:.12em;
      text-transform:uppercase;
    }
    .crm-v1-header h1{
      margin:14px 0 6px;
      font-size:36px;
      line-height:1.02;
      letter-spacing:-.04em;
      color:#fff;
    }
    .crm-v1-header p{
      margin:0;
      color:rgba(228,236,255,.76);
      font-size:15px;
      line-height:1.5;
    }
    .crm-v1-head-actions{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
      align-items:center;
    }
    .crm-v1-stats{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:14px;
      margin-top:18px;
    }
    .crm-v1-stat{
      background:linear-gradient(180deg, rgba(252,253,255,.98), rgba(242,247,255,.96));
      color:#0e1a36;
      border-radius:24px;
      padding:18px 18px 16px;
      border:1px solid rgba(207,220,255,.86);
      box-shadow:0 18px 34px rgba(3,8,20,.18);
    }
    .crm-v1-stat-k{
      font-size:32px;
      line-height:1;
      font-weight:900;
      letter-spacing:-.05em;
      color:#10224d;
    }
    .crm-v1-stat-l{
      margin-top:8px;
      font-size:13px;
      font-weight:800;
      color:#3c4d77;
      text-transform:uppercase;
      letter-spacing:.08em;
    }
    .crm-v1-grid{
      display:grid;
      grid-template-columns:minmax(0,1.25fr) 370px;
      gap:18px;
      align-items:start;
    }
    .crm-v1-surface{
      background:linear-gradient(180deg, rgba(255,255,255,.94), rgba(248,251,255,.90));
      color:#122247;
      border:1px solid rgba(231,239,255,.92);
      border-radius:28px;
      padding:18px;
      backdrop-filter:blur(16px);
      -webkit-backdrop-filter:blur(16px);
      box-shadow:0 18px 40px rgba(0,0,0,.12);
    }
    .crm-v1-surface h2{
      margin:0;
      font-size:24px;
      line-height:1.1;
      letter-spacing:-.03em;
      color:#0f214b;
    }
    .crm-v1-surface-sub{
      margin-top:6px;
      color:#60739d;
      font-size:14px;
    }
    .crm-v1-filterbar{
      display:grid;
      grid-template-columns:1.25fr 0.8fr 0.8fr auto;
      gap:12px;
      margin-top:16px;
      align-items:end;
    }
    .crm-v1-filterbar label{
      color:#5870a1;
      font-weight:800;
      margin-bottom:6px;
    }
    .crm-v1-filterbar input{
      background:#fff !important;
      color:#10224d !important;
      border:1px solid rgba(181,198,235,.92) !important;
      border-radius:16px !important;
      padding:13px 14px !important;
    }
    .crm-v1-list{
      display:grid;
      gap:12px;
      margin-top:16px;
      max-height:860px;
      overflow:auto;
      padding-right:4px;
    }
    .crm-v1-row{
      display:grid;
      grid-template-columns:minmax(0,1.35fr) 110px 110px minmax(0,1fr) auto;
      gap:12px;
      align-items:center;
      padding:16px 16px;
      border-radius:22px;
      border:1px solid rgba(191,207,242,.88);
      background:linear-gradient(180deg, #ffffff, #f5f8ff);
      color:#10224d;
      box-shadow:0 12px 26px rgba(13,23,48,.08);
    }
    .crm-v1-row.active{
      border-color:rgba(72,126,255,.56);
      box-shadow:0 16px 30px rgba(34,83,212,.16);
      background:linear-gradient(180deg, #f7fbff, #edf4ff);
    }
    .crm-v1-row:hover{
      transform:translateY(-1px);
    }
    .crm-v1-name{
      font-size:18px;
      font-weight:800;
      line-height:1.1;
      color:#0f214b;
    }
    .crm-v1-meta{
      margin-top:5px;
      color:#64759b;
      font-size:13px;
    }
    .crm-v1-badge{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      padding:7px 10px;
      border-radius:999px;
      border:1px solid rgba(166,188,238,.9);
      background:#eef4ff;
      color:#35508c;
      font-size:12px;
      font-weight:800;
    }
    .crm-v1-row a{
      color:#215bda;
      font-weight:700;
    }
    .crm-v1-empty{
      padding:28px 18px;
      border-radius:22px;
      border:1px dashed rgba(181,198,235,.92);
      color:#6980ad;
      background:#f8fbff;
      text-align:center;
    }
    .crm-v1-panel{
      display:grid;
      gap:14px;
    }
    .crm-v1-preview-head{
      display:flex;
      justify-content:space-between;
      gap:12px;
      align-items:flex-start;
    }
    .crm-v1-preview-title{
      font-size:30px;
      line-height:1.02;
      font-weight:900;
      letter-spacing:-.04em;
      color:#0f214b;
    }
    .crm-v1-preview-sub{
      margin-top:8px;
      color:#61749d;
      font-size:15px;
    }
    .crm-v1-kv{
      display:grid;
      gap:10px;
    }
    .crm-v1-kv-item{
      padding:14px 16px;
      border-radius:18px;
      background:#f7faff;
      border:1px solid rgba(198,213,246,.9);
    }
    .crm-v1-kv-label{
      color:#6580af;
      font-size:12px;
      font-weight:800;
      text-transform:uppercase;
      letter-spacing:.08em;
    }
    .crm-v1-kv-value{
      margin-top:6px;
      color:#10224d;
      font-size:16px;
      font-weight:700;
      line-height:1.4;
      word-break:break-word;
    }
    .crm-v1-chiprow{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
    }
    .crm-v1-chip{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:8px 10px;
      border-radius:999px;
      background:#eef4ff;
      border:1px solid rgba(170,191,238,.9);
      color:#35508c;
      font-size:12px;
      font-weight:800;
    }
    .crm-v1-actions{
      display:flex;
      gap:10px;
      flex-wrap:wrap;
    }
    .crm-v1-actions .btn{
      border-radius:16px !important;
      padding:11px 14px !important;
    }
    .crm-v1-towns{
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      margin-top:14px;
    }
    .crm-v1-towns a{
      display:inline-flex;
      align-items:center;
      gap:8px;
      padding:9px 12px;
      border-radius:999px;
      background:rgba(255,255,255,.08);
      border:1px solid rgba(255,255,255,.12);
      color:#e8f0ff;
      font-weight:700;
      font-size:13px;
    }
    .crm-v1-note{
      color:#5d739f;
      line-height:1.55;
      font-size:14px;
      white-space:pre-wrap;
    }
    @media (max-width: 1180px){
      .crm-v1-shell{grid-template-columns:1fr}
      .crm-v1-side{position:static}
      .crm-v1-grid{grid-template-columns:1fr}
      .crm-v1-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
    }
    @media (max-width: 760px){
      .crm-v1-filterbar{grid-template-columns:1fr}
      .crm-v1-stats{grid-template-columns:1fr}
      .crm-v1-row{grid-template-columns:1fr}
    }
  </style>

  <div class="crm-v1-shell">
    ${hubSidebar("crm-customers")}

    <main class="crm-v1-main">
      <section class="crm-v1-header">
        <div class="crm-v1-header-top">
          <div class="crm-v1-hero">
            <div class="crm-v1-eyebrow">CRM Shell V1</div>
            <h1>Customers</h1>
            
            <div class="crm-v1-towns">
              ${allTowns.map((t) => `<a href="/customers?town=${encodeURIComponent(t.town)}">${esc(t.town)} <span class="pill">${esc(String(t.count))}</span></a>`).join("")}
            </div>
          </div>
          <div class="crm-v1-head-actions">
            <a class="btn secondary" href="/customers/import">Bulk upload</a>
            <a class="btn" href="/customers/new">+ New customer</a>
            <form method="post" action="/logout" style="margin:0">
              <button class="btn secondary" type="submit">Logout</button>
            </form>
          </div>
        </div>

        <div class="crm-v1-stats">
          <div class="crm-v1-stat">
            <div class="crm-v1-stat-k">${esc(String(stats.total))}</div>
            <div class="crm-v1-stat-l">Total customers</div>
          </div>
          <div class="crm-v1-stat">
            <div class="crm-v1-stat-k">${esc(String(stats.withEmail))}</div>
            <div class="crm-v1-stat-l">With email</div>
          </div>
          <div class="crm-v1-stat">
            <div class="crm-v1-stat-k">${esc(String(stats.withEmployees))}</div>
            <div class="crm-v1-stat-l">With linked employees</div>
          </div>
          <div class="crm-v1-stat">
            <div class="crm-v1-stat-k">${esc(String(stats.needsAttention))}</div>
            <div class="crm-v1-stat-l">Needs attention</div>
          </div>
        </div>
      </section>

      <section class="crm-v1-grid">
        <div class="crm-v1-surface">
          <h2>Customers</h2>
          <div class="crm-v1-surface-sub">Choose a town to load customers.</div>

          <form method="get" action="/customers" class="crm-v1-filterbar">
            <div>
              <label>Search</label>
              <input name="q" value="${esc(q)}" placeholder="name business email phone website town tag" />
            </div>
            <div>
              <label>Town</label>
              <select name="town">
                <option value="">Select town</option>
                ${allTowns.map((t) => `<option value="${esc(t.town)}" ${town === t.town ? "selected" : ""}>${esc(t.town)}</option>`).join("")}
              </select>
            </div>
            <div>
              <label>Tag</label>
              <input name="tag" value="${esc(tag)}" placeholder="e.g. live demo-booked" />
            </div>
            <div>
              <button class="btn secondary" type="submit">Filter</button>
            </div>
          </form>

          <div class="crm-v1-list">
            ${rows.length ? rows.map((r) => {
              const active = selectedFresh && Number(selectedFresh.id) === Number(r.id) ? " active" : "";
              const href = makeCustomerHref(r.id);
              const email = String(r.email || "").trim();
              const phone = String(r.phone || "").trim();
              const website = safeWebHref(r.website);
              return `
                <a class="crm-v1-row${active}" href="${esc(href)}">
                  <div>
                    <div class="crm-v1-name">${esc(r.name)}</div>
                    <div class="crm-v1-meta">${esc(r.business || r.name || "")}</div>
                  </div>
                  <div>
                    <div class="crm-v1-badge">${esc(r.town || "—")}</div>
                  </div>
                  <div>
                    <div class="crm-v1-badge">${esc(String(r.employee_count || 0))} employees</div>
                  </div>
                  <div>
                    <div style="font-weight:800;color:#17346f">${email ? esc(email) : "No email saved"}</div>
                    <div class="crm-v1-meta">${phone ? esc(phone) : "No phone saved"}</div>
                  </div>
                  <div>
                    ${website ? `<span class="crm-v1-badge">Website saved</span>` : `<span class="crm-v1-badge">No website</span>`}
                  </div>
                </a>
              `;
            }).join("") : (q || town || tag ? `<div class="crm-v1-empty">No customers match this filter yet.</div>` : `<div class="crm-v1-empty">Search globally or select a town to load customers.</div>`)}
          </div>
        </div>

        <div class="crm-v1-surface">
          ${selectedFresh ? `
            <div class="crm-v1-panel">
              <div class="crm-v1-preview-head">
                <div>
                  <div class="crm-v1-preview-title">${esc(selectedFresh.name)}</div>
                  <div class="crm-v1-preview-sub">${esc(selectedFresh.town || "Town not set")} • ${esc(selectedFresh.business || selectedFresh.name || "")}</div>
                </div>
                <a class="btn secondary" href="/customers/${selectedFresh.id}/edit">Edit</a>
              </div>

              <div class="crm-v1-actions">
                <a class="btn secondary" href="/customers/${selectedFresh.id}">Open full record</a>
                <a class="btn secondary" href="/customers/${selectedFresh.id}/email/ai">AI Email</a>
                <form method="POST" action="/customers/${selectedFresh.id}/email/sync/outlook" style="margin:0">
                  <button class="btn secondary" type="submit">Sync Outlook</button>
                </form>
              </div>

              <div class="crm-v1-kv">
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Email</div>
                  <div class="crm-v1-kv-value">${selectedFresh.email ? `<a href="mailto:${esc(selectedFresh.email)}">${esc(selectedFresh.email)}</a>` : `<span class="muted">No email saved</span>`}</div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Phone</div>
                  <div class="crm-v1-kv-value">${selectedFresh.phone ? `<a href="tel:${esc(selectedFresh.phone)}">${esc(selectedFresh.phone)}</a>` : `<span class="muted">No phone saved</span>`}</div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Website</div>
                  <div class="crm-v1-kv-value">${selectedFresh.website ? `<a href="${esc(safeWebHref(selectedFresh.website))}" target="_blank" rel="noopener noreferrer">${esc(selectedFresh.website)}</a>` : `<span class="muted">No website saved</span>`}</div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Tags</div>
                  <div class="crm-v1-kv-value">${selectedFresh.tags ? `<div class="crm-v1-chiprow">${selectedFresh.tags.split(/\s+/).filter(Boolean).map(t => `<span class="crm-v1-chip">${esc(t)}</span>`).join("")}</div>` : `<span class="muted">No tags yet</span>`}</div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Linked employees</div>
                  <div class="crm-v1-kv-value">
                    ${selectedEmployees.length
                      ? `<div class="crm-v1-chiprow">${selectedEmployees.map(e => `<a class="crm-v1-chip" href="/employees/${e.id}">${esc(e.full_name)}${e.role ? ` • ${esc(e.role)}` : ""}</a>`).join("")}</div>`
                      : `<span class="muted">No linked employees yet</span>`}
                  </div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Notes</div>
                  <div class="crm-v1-kv-value crm-v1-note">${selectedFresh.notes ? esc(selectedFresh.notes) : `<span class="muted">No notes saved</span>`}</div>
                </div>
                <div class="crm-v1-kv-item">
                  <div class="crm-v1-kv-label">Latest touchpoint</div>
                  <div class="crm-v1-kv-value">
                    ${latestTouchpoint
                      ? `<div style="font-weight:800">${esc(latestTouchpoint.type || "touchpoint")}</div><div class="crm-v1-meta">${new Date(latestTouchpoint.at || 0).toLocaleString()}</div><div class="crm-v1-note" style="margin-top:8px">${esc(latestTouchpoint.note || "No note body")}</div>`
                      : `<span class="muted">No touchpoints yet</span>`}
                  </div>
                </div>
              </div>
            </div>
          ` : `
            <div class="crm-v1-empty">No customer selected yet.</div>
          `}
        </div>
      </section>
    </main>
  </div>
  `;

  return reply.type("text/html").send(layout("Customers", body));
});

fastify.get("/targets", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const status = crmNorm(req.query && req.query.status);
  const due = crmNorm(req.query && req.query.due);
  const validStatus = TARGET_STATUSES.includes(status) ? status : "";
  const today = new Date().toISOString().slice(0, 10);
  let where = TARGET_SCOPE_SQL;
  const params = {};
  if (validStatus) {
    where += " AND target_status=@status";
    params.status = validStatus;
  }
  if (due === "today") {
    where += " AND TRIM(COALESCE(next_follow_up_at,'')) != '' AND next_follow_up_at <= @today";
    params.today = today;
  }

  const rows = db.prepare(`
    SELECT *
    FROM customers
    WHERE ${where}
    ORDER BY updatedAt DESC
    LIMIT 500
  `).all(params);

  const stat = (s) => db.prepare(`
    SELECT COUNT(1) AS n
    FROM customers
    WHERE ${TARGET_SCOPE_SQL}
      AND target_status=?
  `).get(s).n;
  const followDue = db.prepare(`
    SELECT COUNT(1) AS n
    FROM customers
    WHERE ${TARGET_SCOPE_SQL}
      AND TRIM(COALESCE(next_follow_up_at,'')) != ''
      AND next_follow_up_at <= ?
  `).get(today).n;

  const filterLinks = TARGET_STATUSES.map(s => {
    const active = validStatus === s ? " active" : "";
    return `<a class="target-filter${active}" href="/targets?status=${encodeURIComponent(s)}">${esc(targetStatusLabel(s))}</a>`;
  }).join("");

  const body = `
  <style>
    .top{display:none}
    .wrap{max-width:none!important;margin:0!important;padding:0!important}
    .target-shell{display:grid;gap:18px;padding:32px 32px 40px;max-width:1500px;width:100%}
    .target-header,.target-card{border:1px solid rgba(224,236,255,.22);border-radius:24px;padding:18px;background:linear-gradient(180deg,rgba(15,23,42,.88),rgba(2,6,23,.94));box-shadow:0 20px 50px rgba(0,0,0,.28)}
    .target-top{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;flex-wrap:wrap}
    .target-title{font-size:34px;font-weight:900;color:#fff;letter-spacing:-.03em}
    .target-sub{color:#94a3b8;margin-top:6px}
    .target-nav{display:flex;gap:10px;flex-wrap:wrap}
    .target-kpis{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin-top:16px}
    .target-kpi{border:1px solid rgba(255,255,255,.09);border-radius:18px;padding:14px;background:rgba(255,255,255,.04)}
    .target-kpi b{display:block;font-size:26px;color:#fff}.target-kpi span{color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.08em}
    .target-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
    .target-filter{display:inline-flex;padding:8px 11px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);color:#dbeafe;font-weight:800;font-size:12px}
    .target-filter.active{background:linear-gradient(180deg,rgba(66,123,255,.24),rgba(35,83,210,.18));border-color:rgba(102,147,255,.44)}
    .target-table{width:100%;border-collapse:collapse}.target-table th,.target-table td{padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top}.target-table th{color:#94a3b8;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.target-table td{color:#e5edf9}
    .target-status-form{display:grid;grid-template-columns:1fr 1fr 1.5fr auto;gap:8px;align-items:end;margin-top:8px}.target-status-form input,.target-status-form select{min-height:38px}
    @media(max-width:900px){.target-shell{padding:18px}.target-kpis{grid-template-columns:1fr 1fr}.target-table{display:block;overflow:auto}.target-status-form{grid-template-columns:1fr}}
  </style>
  <div class="hub-ecosystem-layout">
    ${hubSidebar("crm-targets")}
    <div class="target-shell">
      <section class="target-header">
      <div class="target-top">
        <div>
          <div class="target-title">Target Pipeline</div>
          <div class="target-sub">Lead Engine targets inside the existing CRM customer table.</div>
        </div>
        <div class="target-nav">
          <a class="btn secondary" href="/customers">Customers</a>
          <a class="btn secondary" href="/customers/328">Test record #328</a>
        </div>
      </div>
      <div class="target-kpis">
        <div class="target-kpi"><b>${esc(String(stat("new_target")))}</b><span>New targets</span></div>
        <div class="target-kpi"><b>${esc(String(stat("ready_to_contact")))}</b><span>Ready to contact</span></div>
        <div class="target-kpi"><b>${esc(String(stat("email_sent")))}</b><span>Email sent</span></div>
        <div class="target-kpi"><b>${esc(String(stat("replied")))}</b><span>Replied</span></div>
        <div class="target-kpi"><b>${esc(String(followDue))}</b><span>Follow-up due</span></div>
      </div>
      </section>
      <section class="target-card">
      <div class="target-filters">
        <a class="target-filter${validStatus || due ? "" : " active"}" href="/targets">All targets</a>
        <a class="target-filter${due === "today" ? " active" : ""}" href="/targets?due=today">Today / Overdue</a>
        ${filterLinks}
      </div>
      <table class="target-table">
        <thead><tr><th>Business</th><th>Town</th><th>Industry</th><th>Email</th><th>Phone</th><th>Target status</th><th>Next follow-up</th><th>Open record</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><b>${esc(r.business || r.name)}</b><div class="muted">${esc(r.name || "")}</div></td>
              <td>${esc(r.town || "—")}</td>
              <td>${esc(r.lead_industry || "—")}</td>
              <td>${r.email ? `<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>` : "—"}</td>
              <td>${r.phone ? `<a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>` : "—"}</td>
              <td>${esc(targetStatusLabel(r.target_status || "new_target"))}</td>
              <td>${esc(r.next_follow_up_at || "—")}</td>
              <td><a class="btn secondary" href="/customers/${r.id}">Open</a></td>
            </tr>
            <tr>
              <td colspan="8">
                <form class="target-status-form" method="POST" action="/targets/${r.id}/status">
                  <label>Status<select name="target_status">${TARGET_STATUSES.map(s => `<option value="${esc(s)}" ${s === (r.target_status || "new_target") ? "selected" : ""}>${esc(targetStatusLabel(s))}</option>`).join("")}</select></label>
                  <label>Next follow-up<input name="next_follow_up_at" value="${esc(r.next_follow_up_at || "")}" placeholder="YYYY-MM-DD"></label>
                  <label>Pipeline note<input name="pipeline_notes" placeholder="Append a note"></label>
                  <button class="btn" type="submit">Update</button>
                </form>
                <form method="POST" action="/targets/${r.id}/archive" style="margin-top:8px;text-align:right" onsubmit="return confirm('Remove this record from Targets? The customer record will be kept.');">
                  <button class="btn secondary" type="submit">Remove from targets</button>
                </form>
              </td>
            </tr>
          `).join("") || `<tr><td colspan="9">No targets found.</td></tr>`}
        </tbody>
      </table>
      </section>
    </div>
  </div>`;

  return reply.type("text/html").send(layout("Target Pipeline", body));
});

fastify.post("/targets/:id/status", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const c = db.prepare("SELECT * FROM customers WHERE id=?").get(id);
  if (!c) return reply.code(404).send("Not found");
  const b = req.body || {};
  const targetStatus = TARGET_STATUSES.includes(String(b.target_status || "")) ? String(b.target_status) : (c.target_status || "new_target");
  const outreachStatus = crmNorm(b.outreach_status) || c.outreach_status || "";
  const nextFollowUp = crmNorm(b.next_follow_up_at) || c.next_follow_up_at || "";
  const pipelineNotes = appendPipelineNotes(c.pipeline_notes || "", b.pipeline_notes || "");
  db.prepare(`
    UPDATE customers
    SET target_status=?, outreach_status=?, next_follow_up_at=?, pipeline_notes=?, updatedAt=?
    WHERE id=?
  `).run(targetStatus, outreachStatus, nextFollowUp, pipelineNotes, now(), id);
  return reply.redirect(`/targets?status=${encodeURIComponent(targetStatus)}`);
});

fastify.post("/targets/:id/archive", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const c = db.prepare("SELECT * FROM customers WHERE id=?").get(id);
  if (!c) return reply.code(404).send("Not found");
  const note = `Removed from Targets pipeline ${new Date().toISOString()}`;
  const pipelineNotes = appendPipelineNotes(c.pipeline_notes || "", note);
  db.prepare(`
    UPDATE customers
    SET target_status='archived', pipeline_notes=?, updatedAt=?
    WHERE id=?
  `).run(pipelineNotes, now(), id);
  return reply.redirect("/targets");
});

function customerForm(title, action, c = {}) {
  return layout(
    title,
    `<div class="grid">
      <div class="card">
        <div style="font-weight:800;font-size:18px">${esc(title)}</div>
        <form method="post" action="${esc(action)}">
          <label>Name</label>
          <input name="name" required value="${esc(c.name)}" />
          <label>Business</label>
          <input name="business" value="${esc(c.business)}" />
          <label>Email</label>
<div style="display:flex; gap:8px; align-items:center">
  <input name="email" id="email" value="${esc(c.email)}" style="flex:1" />
  <a class="btn secondary" id="emailBtn"
     href="${c.email ? `mailto:${encodeURIComponent(c.email)}` : "#"}"
     ${c.email ? "" : 'aria-disabled="true" style="opacity:.45; pointer-events:none"'}
  >Email</a>
</div>
<script>
(function(){
 const i=document.getElementById("email");
 const b=document.getElementById("emailBtn");
 if(!i||!b)return;
 function s(){
  const v=(i.value||"").trim();
  if(v){b.href="mailto:"+encodeURIComponent(v);b.style.opacity="1";b.style.pointerEvents="auto";}
  else{b.href="#";b.style.opacity=".45";b.style.pointerEvents="none";}
 }
 i.addEventListener("input",s); s();
})();
</script>
          <label>Phone</label>
          <input name="phone" value="${esc(c.phone)}" />
          <label>Town</label>
          <input name="town" value="${esc(c.town)}" />
          <label>Website</label>
          <input name="website" value="${esc(c.website)}" placeholder="https://..." />
          <label>Tags</label>
          <input name="tags" value="${esc(c.tags)}" placeholder="space separated e.g. live demo-booked" />
          <label>Employees</label>
          <textarea name="employees" placeholder="One per line. Name | Role | LinkedIn | Stage | Status | Last msg | Next follow-up | Notes">${esc(c.employees)}</textarea>
          <label>Notes</label>
          <textarea name="notes">${esc(c.notes)}</textarea>
          <div class="row" style="margin-top:12px;justify-content:space-between">
            <a class="btn secondary" href="/customers">Cancel</a>
            <button class="btn" type="submit">Save</button>
          <button class="btn danger" type="submit" formaction="/customers/${c.id}/delete" formmethod="post" onclick="return confirm('Delete this customer?' )">Delete</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div style="font-weight:800;margin-bottom:10px">Bulk upload</div>
        <div class="muted">Use <a href="/customers/import">Bulk upload</a> to import a CSV file.</div>
      </div>
    </div>`
  );
}

fastify.get("/customers/new", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  return reply.type("text/html").send(customerForm("New customer", "/customers/new"));
});

fastify.post("/customers/new", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const b = req.body || {};
  const ts = now();
  db.prepare(
    `INSERT INTO customers (name,business,email,phone,town,website,tags,notes,createdAt,updatedAt)
     VALUES (@name,@business,@email,@phone,@town,@website,@tags,@notes,@createdAt,@updatedAt)`
  ).run({
    name: String(b.name || "").trim(),
    business: String(b.business || "").trim(),
    email: String(b.email || "").trim(),
    phone: String(b.phone || "").trim(),
    town: String(b.town || "").trim(),
    website: String(b.website || "").trim(),
    tags: String(b.tags || "").trim(),
    employees: String(b.employees || "").trim(),
      notes: String(b.notes || "").trim(),
    createdAt: ts,
    updatedAt: ts,
  });
  return reply.redirect("/customers");
});

fastify.get("/customers/:id", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
  if (!c) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const tps = db
    .prepare(`SELECT * FROM touchpoints WHERE customerId=? ORDER BY at DESC LIMIT 100`)
    .all(id);

  const linkedEmployees = customerEmployeeLinks(id);
  const allEmployees = allEmployeesForPicklist();
  const isTarget = isTargetCustomer(c);
  const targetPanel = isTarget ? `
        <div class="card glass">
          <div class="muted" style="font-size:11px">TARGET PIPELINE</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:10px">
            <div><div class="muted" style="font-size:11px">Target status</div><div style="font-weight:700">${esc(targetStatusLabel(c.target_status || "new_target"))}</div></div>
            <div><div class="muted" style="font-size:11px">Outreach status</div><div style="font-weight:700">${esc(c.outreach_status || "not_contacted")}</div></div>
            <div><div class="muted" style="font-size:11px">Lead source</div><div style="font-weight:700">${esc(c.lead_source || "—")}</div></div>
            <div><div class="muted" style="font-size:11px">Industry</div><div style="font-weight:700">${esc(c.lead_industry || "—")}</div></div>
            <div><div class="muted" style="font-size:11px">Last contacted</div><div style="font-weight:700">${esc(c.last_contacted_at || "—")}</div></div>
            <div><div class="muted" style="font-size:11px">Next follow-up</div><div style="font-weight:700">${esc(c.next_follow_up_at || "—")}</div></div>
            <div><div class="muted" style="font-size:11px">Replied at</div><div style="font-weight:700">${esc(c.replied_at || "—")}</div></div>
          </div>
          ${c.pipeline_notes ? `<div class="muted" style="font-size:11px;margin-top:12px">Pipeline notes</div><div style="white-space:pre-wrap;margin-top:6px">${esc(c.pipeline_notes)}</div>` : ""}
        </div>` : "";

  const emailBtn = `<a class="btn" href="/customers/${c.id}/email/ai">AI Email</a>`;
  const callBtn = c.phone ? `<a class="btn secondary" href="tel:${esc(c.phone)}">Call</a>` : `<span class="btn secondary">No phone</span>`;

  const web = c.website ? String(c.website).trim() : "";
  const webHref = web && !/^https?:\/\//i.test(web) ? `https://${web}` : web;
  const webBtn = webHref
    ? `<a class="btn secondary" href="${esc(webHref)}" target="_blank" rel="noopener noreferrer">Website</a>`
    : `<span class="btn secondary">No website</span>`;

  const body = `
  <div class="grid">
    <div class="card glass">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;flex-wrap:wrap">

        <div>
          <div style="font-size:28px;font-weight:900;letter-spacing:.3px">${esc(c.name)}</div>
          <div class="muted" style="margin-top:4px;font-size:14px">
            ${esc(c.business)} ${c.town ? " • " + esc(c.town) : ""}
          </div>

          <div style="margin-top:14px;display:flex;gap:8px;flex-wrap:wrap">
            ${emailBtn}
            <form method="POST" action="/customers/${c.id}/email/sync/outlook" style="display:inline">
              <button class="btn" type="submit">Sync Outlook</button>
            </form>
            ${callBtn}
            ${webBtn}
            <a class="btn secondary" href="/customers/${c.id}/edit">Edit</a>
            ${isTarget ? `<a class="btn secondary" href="/targets">Targets</a>` : ""}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end">
          <a class="btn secondary" href="/customers">Back</a>

          <div style="display:flex;gap:10px;margin-top:6px">
            <div style="text-align:right">
              <div class="muted" style="font-size:11px">STATUS</div>
              <div style="font-weight:700">Active</div>
            </div>
            <div style="text-align:right">
              <div class="muted" style="font-size:11px">UPDATED</div>
              <div style="font-weight:700">${c.updatedAt ? new Date(c.updatedAt).toISOString().slice(0,10) : "—"}</div>
            </div>
          </div>
        </div>

      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px">
        ${targetPanel}

        <div class="card glass">
          <div class="muted" style="font-size:11px">EMAIL</div>
          <div style="margin-top:6px;font-weight:600">
            ${c.email ? `<a href="/customers/${c.id}/email/ai">${esc(c.email)}</a>` : "—"}
          </div>
        </div>

        <div class="card glass">
          <div class="muted" style="font-size:11px">PHONE</div>
          <div style="margin-top:6px;font-weight:600">
            ${c.phone ? `<a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : "—"}
          </div>
        </div>

        <div class="card glass">
          <div class="muted" style="font-size:11px">WEBSITE</div>
          <div style="margin-top:6px;font-weight:600">
            ${webHref ? `<a href="${esc(webHref)}" target="_blank" rel="noopener noreferrer">${esc(webHref)}</a>` : "—"}
          </div>
        </div>

      </div>

      <div class="card glass" style="margin-top:14px">
        <div style="display:flex;flex-direction:column;gap:12px">

          <div>
            <div class="muted" style="font-size:11px">TAGS</div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">
              ${c.tags
                ? c.tags.split(/[ ,]+/).filter(Boolean).map(t => `<span class="pill">${esc(t)}</span>`).join("")
                : "<span class='muted'>—</span>"}
            </div>
          </div>

          <div>
            <div class="muted" style="font-size:11px">NOTES</div>
            <div style="margin-top:6px;white-space:pre-wrap;line-height:1.5">
              ${esc(c.notes) || "<span class='muted'>—</span>"}
            </div>
          </div>

        </div>
      </div>
    </div>

    <div style="display:grid;gap:12px">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div style="font-weight:800">Linked employees</div>
          <a class="pill" href="/employees">Employees</a>
        </div>

        <div style="margin-top:10px">
          ${
            linkedEmployees.length === 0
              ? `<div class="muted">None linked yet</div>`
              : `<table>
                   <thead>
                     <tr><th>Name</th><th>Role</th><th></th></tr>
                   </thead>
                   <tbody>
                     ${linkedEmployees
                       .map((e) => `
                         <tr>
                           <td><a href="/employees/${e.id}">${esc(e.full_name)}</a></td>
                           <td>${esc(e.role || "—")}</td>
                           <td class="right">
                             <form method="post" action="/customers/${c.id}/employees/unlink" style="margin:0">
                               <input type="hidden" name="employee_id" value="${esc(e.id)}" />
                               <button class="btn secondary" type="submit">Unlink</button>
                             </form>
                           </td>
                         </tr>`)
                       .join("")}
                   </tbody>
                 </table>`
          }
        </div>

        <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
          <form method="post" action="/customers/${c.id}/employees/link">
            <label>Link existing employees (select one or many)</label>
            <select name="employeeIds" multiple size="8">
              ${allEmployees
                .filter((e) => !linkedEmployees.some((x) => x.id === e.id))
                .map((e) => `<option value="${e.id}">${esc(e.full_name)}${e.role ? " • " + esc(e.role) : ""}</option>`)
                .join("")}
            </select>
            <div class="row" style="margin-top:10px;justify-content:flex-end">
              <button class="btn" type="submit">Link</button>
            </div>
          </form>
        </div>
      </div>

      <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center">
            <div style="font-weight:800">Email history</div>
          </div>

          ${(() => {
            const emails = db.prepare("SELECT type, note, email_body, email_subject, email_from, email_to, at FROM touchpoints WHERE customerId=? AND type IN ('email_out','email_in') ORDER BY at DESC LIMIT 20").all(id);
            if (!emails.length) return `<div class="muted" style="margin-top:10px">No emails logged yet</div>`;
            return emails.map((msg, idx) => {
              const when = msg.at ? new Date(msg.at * 1000).toISOString().replace("T"," ").slice(0,16) : "";
              const body = String(msg.email_body || msg.note || "").trim();
              const clipped = body.length > 3000 ? body.slice(0, 2990) + "..." : body;
              return `
                <div style="${idx === 0 ? 'margin-top:10px' : 'margin-top:14px;padding-top:14px;border-top:1px solid var(--line)'}">
                  <div class="muted">${esc(when)} • ${esc(msg.type || '')}</div>
                  ${msg.email_subject ? `<div class="muted" style="margin-top:6px">Subject: ${esc(msg.email_subject)}</div>` : (msg.note ? `<div class="muted" style="margin-top:6px">${esc(msg.note)}</div>` : ``)}
                  ${msg.email_from ? `<div class="muted" style="margin-top:4px">From: ${esc(msg.email_from)}</div>` : ``}
                  ${msg.email_to ? `<div class="muted" style="margin-top:4px">To: ${esc(msg.email_to)}</div>` : ``}
                  <details style="margin-top:10px">
                    <summary class="muted" style="cursor:pointer">Show email</summary>
                    <pre style="white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;max-width:100%;overflow-x:auto;margin:10px 0 0 0;border:1px solid var(--border);background:var(--panel);padding:10px;border-radius:10px">${esc(clipped)}</pre>
                  </details>
                </div>
              `;
            }).join("");
          })()}
        </div>

<div class="card">
        <div style="font-weight:800;margin-bottom:10px">Touchpoints</div>
        <form method="post" action="/customers/${c.id}/touchpoints">
          <label>Type</label>
          <input name="type" placeholder="call email visit note" required />
          <label>Note</label>
          <textarea name="note" placeholder="What happened"></textarea>
          <button class="btn" type="submit" style="margin-top:10px">Add</button>
        </form>

        <div style="margin-top:12px">
          ${tps.length === 0 ? `<div class="muted">No touchpoints yet</div>` : ""}
          ${tps
            .map((tp) => {
              const d = new Date(tp.at).toISOString().replace("T", " ").slice(0, 16);
              return `<div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
                <div class="row" style="justify-content:space-between">
                  <div class="pill">${esc(tp.type)}</div>
                  <div class="muted">${esc(d)}</div>
                </div>
                <div style="white-space:pre-wrap;margin-top:8px">${esc(tp.note)}</div>
              </div>`;
            })
            .join("")}
        </div>
      </div>
    </div>
  </div>`;

  return reply.type("text/html").send(layout(c.name, body));
});

fastify.post("/customers/:id/touchpoints", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const b = req.body || {};
  db.prepare(`INSERT INTO touchpoints (customerId,type,note,at) VALUES (?,?,?,?)`).run(
    id,
    String(b.type || "note").trim(),
    String(b.note || "").trim(),
    now()
  );
  db.prepare(`UPDATE customers SET updatedAt=? WHERE id=?`).run(now(), id);
  return reply.redirect(`/customers/${id}`);
});

fastify.post("/customers/:id/employees/link", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const customerId = Number(req.params.id);
  const c = db.prepare(`SELECT id FROM customers WHERE id=?`).get(customerId);
  if (!c) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const b = req.body || {};
  const idsRaw = b.employeeIds;
  const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw ? [idsRaw] : []);

  for (const idRaw of ids) {
    const eid = Number(idRaw);
    if (Number.isFinite(eid)) {
      db.prepare(`INSERT OR IGNORE INTO employee_customers (employee_id, customer_id) VALUES (?, ?)`).run(eid, customerId);
    }
  }

  db.prepare(`UPDATE customers SET updatedAt=? WHERE id=?`).run(now(), customerId);
  return reply.redirect(`/customers/${customerId}`);
});

fastify.post("/customers/:id/employees/unlink", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const customerId = Number(req.params.id);
  const c = db.prepare(`SELECT id FROM customers WHERE id=?`).get(customerId);
  if (!c) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const b = req.body || {};
  const employeeId = Number(b.employee_id);
  if (Number.isFinite(employeeId)) {
    db.prepare(`DELETE FROM employee_customers WHERE employee_id=? AND customer_id=?`).run(employeeId, customerId);
  }

  db.prepare(`UPDATE customers SET updatedAt=? WHERE id=?`).run(now(), customerId);
  return reply.redirect(`/customers/${customerId}`);
});

fastify.get("/customers/:id/edit", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(id);
  if (!c) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));
  return reply.type("text/html").send(customerForm("Edit customer", `/customers/${id}/edit`, c));
});

fastify.post("/customers/:id/edit", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const b = req.body || {};
  db.prepare(
    `UPDATE customers
     SET name=@name,business=@business,email=@email,phone=@phone,town=@town,website=@website,tags=@tags,employees=@employees,notes=@notes,updatedAt=@updatedAt
     WHERE id=@id`
  ).run({
    id,
    name: String(b.name || "").trim(),
    business: String(b.business || "").trim(),
    email: String(b.email || "").trim(),
    phone: String(b.phone || "").trim(),
    town: String(b.town || "").trim(),
    website: String(b.website || "").trim(),
    tags: String(b.tags || "").trim(),
    notes: String(b.notes || "").trim(),
      employees: String(b.employees || "").trim(),
    updatedAt: now(),
  });  return reply.redirect(`/customers/${id}`);
});

fastify.post("/customers/:id/delete", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  db.prepare("DELETE FROM employee_customers WHERE customer_id=?").run(id);
  db.prepare("DELETE FROM customers WHERE id=?").run(id);
  return reply.redirect("/customers");
});

/* =========================
   Bulk Upload (CSV)
   ========================= */
fastify.get("/customers/import", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const body = `
    <div class="card">
      <div style="font-weight:800;font-size:18px">Bulk upload customers</div>
      <div class="muted" style="margin-top:8px">
        Upload a CSV with headers:<br/>
        <code>name,business,email,phone,town,website,tags,notes</code><br/><br/>
        <span class="pill">Upsert rule</span> If <b>email</b> matches an existing customer it updates that record.
      </div>

      <div style="margin-top:12px" class="row">
        <a class="btn secondary" href="/customers/import/sample.csv">Download sample CSV</a>
        <a class="btn secondary" href="/customers">Back to customers</a>
      </div>

      <form method="post" action="/customers/import" enctype="multipart/form-data" style="margin-top:12px">
        <label>CSV file</label>
        <input type="file" name="file" accept=".csv,text/csv" required />
        <div class="row" style="margin-top:12px;justify-content:flex-end">
          <button class="btn" type="submit">Import</button>
        </div>
      </form>
    </div>
  `;
  return reply.type("text/html").send(layout("Bulk upload", body));
});

fastify.get("/customers/import/sample.csv", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const sample =
    "name,business,email,phone,town,website,tags,notes\n" +
    'Gary Test,Test Bistro,hello@testbistro.co.uk,+447700900123,Cambridge,https://example.com,live demo-booked,"Founder demo booked Tuesday"\n' +
    'Sue Example,Example Cafe,sue@examplecafe.co.uk,+447700900456,Norwich,https://example.com,warm follow-up,"Owner interested but busy at lunch"\n';
  reply
    .header("Content-Type", "text/csv; charset=utf-8")
    .header("Content-Disposition", 'attachment; filename="crm-sample.csv"')
    .send(sample);
});

fastify.post("/customers/import", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const part = await req.file();
  if (!part) return reply.redirect("/customers/import");

  const buf = await part.toBuffer();
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");

  const rows = parseCSV(text);
  if (!rows.length) return reply.redirect("/customers/import");

  const headers = rows[0].map(normalizeHeader);
  const idx = (name) => headers.indexOf(normalizeHeader(name));

  const required = ["name"];
  const missingRequired = required.filter((h) => idx(h) === -1);
  if (missingRequired.length) {
    const body = `<div class="err">Missing required header: ${esc(missingRequired.join(", "))}</div>
      <div class="card"><a class="btn secondary" href="/customers/import">Back</a>
<form method="POST" action="/employees/${e.id}/email/sync/outlook" style="margin-top:10px;"><button class="btn" type="submit">Sync Outlook Inbox</button></form></div>`;
    return reply.type("text/html").send(layout("Import error", body));
  }

  const get = (r, key) => {
    const i = idx(key);
    return i === -1 ? "" : String(r[i] ?? "").trim();
  };

  const findByEmail = db.prepare(`SELECT id FROM customers WHERE email = ? LIMIT 1`);
  const insert = db.prepare(`
    INSERT INTO customers (name,business,email,phone,town,website,tags,notes,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const update = db.prepare(`
    UPDATE customers
    SET name=?, business=?, phone=?, town=?, website=?, tags=?, notes=?, updatedAt=?
    WHERE id=?
  `);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  const ts = now();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((x) => String(x).trim() === "")) continue;

    const name = get(r, "name");
    if (!name) {
      skipped++;
      continue;
    }

    const business = get(r, "business");
    const email = get(r, "email");
    const phone = get(r, "phone");
    const town = get(r, "town");
    const website = get(r, "website");
    const tags = get(r, "tags");
    const notes = get(r, "notes");

    if (email) {
      const existing = findByEmail.get(email);
      if (existing && existing.id) {
        update.run(name, business, phone, town, website, tags, notes, ts, existing.id);
        updated++;
        continue;
      }
    }

    insert.run(name, business, email, phone, town, website, tags, notes, ts, ts);
    inserted++;
  }

  const body = `
    <div class="card">
      <div style="font-weight:800;font-size:18px">Import complete</div>
      <div style="margin-top:10px" class="row">
        <div class="pill">Inserted ${inserted}</div>
        <div class="pill">Updated ${updated}</div>
        <div class="pill">Skipped ${skipped}</div>
      </div>
      <div class="row" style="margin-top:12px">
        <a class="btn" href="/customers">Go to customers</a>
        <a class="btn secondary" href="/customers/import">Import another</a>
      </div>
    </div>
  `;
  return reply.type("text/html").send(layout("Import complete", body));
});

fastify.post("/api/import-lead", async (req, reply) => {
  if (!crmIsLocalRequest(req)) {
    return reply.code(403).send({ ok: false, error: "local requests only" });
  }

  const lead = req.body || {};
  const name = crmNorm(lead.name || lead.business);
  const business = crmNorm(lead.business || lead.name);
  const email = crmNorm(lead.email || lead.primaryEmail);
  const phone = crmNorm(lead.phone);
  const town = crmNorm(lead.town || lead.city || lead.county);
  const website = crmNorm(lead.website);
  const leadIndustry = crmNorm(lead.industryProfileLabel || lead.industryProfile);
  const tags = Array.from(new Set([
    "lead-engine",
    crmNorm(lead.industryProfile || "").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase(),
    crmNorm(lead.pipelineStatus || "").replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()
  ].filter(Boolean))).join(" ");
  const notes = crmBuildLeadEngineNotes(lead);

  if (!name && !business) {
    return reply.code(400).send({ ok: false, error: "name or business required" });
  }

  const rows = db.prepare("SELECT * FROM customers").all();
  const websiteKey = crmNormWebsite(website);
  const emailKey = crmNormLower(email);
  const phoneKey = phone.replace(/\D/g, "");
  const businessTownKey = `${crmNormLower(business || name)}|${crmNormLower(town)}`;
  const existing = rows.find(r => websiteKey && crmNormWebsite(r.website) === websiteKey)
    || rows.find(r => emailKey && crmNormLower(r.email) === emailKey)
    || rows.find(r => phoneKey && String(r.phone || "").replace(/\D/g, "") === phoneKey)
    || rows.find(r => businessTownKey !== "|" && `${crmNormLower(r.business || r.name)}|${crmNormLower(r.town)}` === businessTownKey);

  const ts = now();
  if (existing && existing.id) {
    const mergedNotes = [crmNorm(existing.notes), notes].filter(Boolean).join("\n\n---\n");
    const mergedTags = Array.from(new Set(`${existing.tags || ""} ${tags}`.split(/\s+/).filter(Boolean))).join(" ");
    db.prepare(`
      UPDATE customers
      SET name=?, business=?, email=?, phone=?, town=?, website=?, tags=?, notes=?,
          target_status=?, lead_source=?, lead_industry=?, outreach_status=?, updatedAt=?
      WHERE id=?
    `).run(
      name || existing.name,
      business || existing.business,
      email || existing.email,
      phone || existing.phone,
      town || existing.town,
      website || existing.website,
      mergedTags,
      mergedNotes,
      existing.target_status || "new_target",
      existing.lead_source || "lead_engine",
      existing.lead_industry || leadIndustry,
      existing.outreach_status || "not_contacted",
      ts,
      existing.id
    );
    return reply.send({ ok: true, customerId: existing.id, action: "updated" });
  }

  const info = db.prepare(`
    INSERT INTO customers
      (name,business,email,phone,town,website,tags,notes,target_status,lead_source,lead_industry,outreach_status,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(name || business, business, email, phone, town, website, tags, notes, "new_target", "lead_engine", leadIndustry, "not_contacted", ts, ts);

  return reply.send({ ok: true, customerId: info.lastInsertRowid, action: "created" });
});

fastify.get("/health", async () => ({ ok: true }));

function customerEmployeeLinks(customerId) {
  return db
    .prepare(
      `SELECT e.id, e.full_name, e.role
       FROM employees e
       JOIN employee_customers ec ON ec.employee_id = e.id
       WHERE ec.customer_id = ?
       ORDER BY e.updated_at DESC, e.full_name ASC`
    )
    .all(customerId);
}

function allEmployeesForPicklist() {
  return db.prepare(`SELECT id, full_name, role FROM employees ORDER BY updated_at DESC, full_name ASC LIMIT 2000`).all();
}

function employeeCustomerLinks(employeeId) {
  return db
    .prepare(
      `SELECT c.id, c.name, c.town
       FROM customers c
       JOIN employee_customers ec ON ec.customer_id = c.id
       WHERE ec.employee_id = ?
       ORDER BY c.updatedAt DESC`
    )
    .all(employeeId);
}

function allCustomersForPicklist() {
  return db.prepare(`SELECT id,name,town FROM customers ORDER BY updatedAt DESC LIMIT 2000`).all();
}

function getOutboundOpenerRowsByTown(town) {
  const townNeedle = `%${String(town || "").trim().toLowerCase()}%`;

  return db.prepare(`
    SELECT
      c.id AS customer_id,
      c.name AS restaurant_name,
      c.town,
      c.email AS restaurant_email,

      e.id AS employee_id,
      e.full_name AS contact_name,
      e.email AS contact_email,
      'employee' AS contact_type,

      CASE
        WHEN LOWER(TRIM(COALESCE(e.role,''))) IN ('owner','founder','director','general manager','manager') THEN 1
        ELSE 0
      END AS priority_rank

    FROM customers c
    JOIN employee_customers ec ON ec.customer_id = c.id
    JOIN employees e ON e.id = ec.employee_id
    WHERE LOWER(c.town) LIKE ?
      AND e.email IS NOT NULL
      AND TRIM(e.email) != ''
      AND NOT EXISTS (
        SELECT 1
        FROM mc.outbound_queue oq
        WHERE oq.restaurant_id = c.id
      )

    UNION ALL

    SELECT
      c.id AS customer_id,
      c.name AS restaurant_name,
      c.town,
      c.email AS restaurant_email,

      NULL AS employee_id,
      NULL AS contact_name,
      c.email AS contact_email,
      'restaurant' AS contact_type,

      0 AS priority_rank

    FROM customers c
    WHERE LOWER(c.town) LIKE ?
      AND c.email IS NOT NULL
      AND TRIM(c.email) != ''
      AND NOT EXISTS (
        SELECT 1
        FROM mc.outbound_queue oq
        WHERE oq.restaurant_id = c.id
      )

    ORDER BY restaurant_name, priority_rank DESC, contact_type, contact_name
  `).all(townNeedle, townNeedle);
}

function groupOutboundOpenerRows(rows) {
  const byCustomer = new Map();

  for (const row of rows) {
    const key = String(row.customer_id);
    let item = byCustomer.get(key);

    if (!item) {
      item = {
        customer_id: row.customer_id,
        restaurant_name: row.restaurant_name || "",
        town: row.town || "",
        restaurant_email: row.restaurant_email || "",
        contacts: [],
        primary_contact_index: -1
      };
      byCustomer.set(key, item);
    }

    const contactEmail = String(row.contact_email || "").trim();
    if (!contactEmail) continue;

    const dedupeKey = `${row.contact_type}|${row.employee_id || ""}|${contactEmail.toLowerCase()}`;
    if (item.contacts.some(c => c._dedupeKey === dedupeKey)) continue;

    item.contacts.push({
      employee_id: row.employee_id || null,
      contact_name: row.contact_name || null,
      email: contactEmail,
      contact_type: row.contact_type,
      _dedupeKey: dedupeKey
    });
  }

  const results = [];
  for (const item of byCustomer.values()) {
    item.contacts.sort((a, b) => {
      if (a.contact_type !== b.contact_type) return a.contact_type === "employee" ? -1 : 1;
      const an = String(a.contact_name || "").toLowerCase();
      const bn = String(b.contact_name || "").toLowerCase();
      return an.localeCompare(bn);
    });

    item.primary_contact_index = item.contacts.findIndex(c => c.contact_type === "employee");
    if (item.primary_contact_index === -1 && item.contacts.length > 0) {
      item.primary_contact_index = 0;
    }

    item.contact_count = item.contacts.length;
    item.contacts = item.contacts.map(({ _dedupeKey, ...rest }) => rest);

    results.push(item);
  }

  return results.sort((a, b) => a.restaurant_name.localeCompare(b.restaurant_name));
}

fastify.get("/api/outbound/openers/search", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const town = String((req.query && req.query.town) || "").trim();
  if (!town) {
    return reply.send({ ok: true, town: "", count: 0, results: [] });
  }

  const rows = getOutboundOpenerRowsByTown(town);
  const results = groupOutboundOpenerRows(rows);

  return reply.send({
    ok: true,
    town,
    count: results.length,
    results
  });
});

function getSelectableOutboundContactsForCustomer(customerId) {
  const rows = db.prepare(`
    SELECT
      c.id AS customer_id,
      c.name AS restaurant_name,
      c.town,
      c.email AS restaurant_email,

      e.id AS employee_id,
      e.full_name AS contact_name,
      e.email AS contact_email,
      'employee' AS contact_type

    FROM customers c
    JOIN employee_customers ec ON ec.customer_id = c.id
    JOIN employees e ON e.id = ec.employee_id
    WHERE c.id = ?
      AND e.email IS NOT NULL
      AND TRIM(e.email) != ''

    UNION ALL

    SELECT
      c.id AS customer_id,
      c.name AS restaurant_name,
      c.town,
      c.email AS restaurant_email,

      NULL AS employee_id,
      NULL AS contact_name,
      c.email AS contact_email,
      'restaurant' AS contact_type

    FROM customers c
    WHERE c.id = ?
      AND c.email IS NOT NULL
      AND TRIM(c.email) != ''

    ORDER BY contact_type, contact_name
  `).all(customerId, customerId);

  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const email = String(row.contact_email || "").trim();
    if (!email) continue;

    const key = `${row.contact_type}|${row.employee_id || ""}|${email.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      customer_id: row.customer_id,
      restaurant_name: row.restaurant_name || "",
      town: row.town || "",
      restaurant_email: row.restaurant_email || "",
      employee_id: row.employee_id || null,
      contact_name: row.contact_name || null,
      email,
      contact_type: row.contact_type
    });
  }

  return out;
}

fastify.post("/api/outbound/openers/add", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const body = req.body || {};
  const selections = Array.isArray(body.selections) ? body.selections : [];

  if (!selections.length) {
    return reply.code(400).send({ ok: false, error: "No selections provided" });
  }

  const insertStmt = db.prepare(`
    INSERT INTO mc.outbound_queue (
      restaurant_id,
      employee_id,
      restaurant_name,
      contact_name,
      email,
      contact_type,
      status,
      step,
      sequence_total,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 4, ?, ?)
  `);

  const existsStmt = db.prepare(`
    SELECT id
    FROM mc.outbound_queue
    WHERE restaurant_id = ?
      AND COALESCE(employee_id, 0) = COALESCE(?, 0)
      AND LOWER(email) = LOWER(?)
    LIMIT 1
  `);

  const inserted = [];
  const skipped = [];
  const nowMs = Date.now();

  const tx = db.transaction((items) => {
    for (const item of items) {
      const customerId = Number(item.customer_id || 0);
      if (!customerId) {
        skipped.push({ ...item, reason: "invalid_customer_id" });
        continue;
      }

      const wantedType = String(item.contact_type || "").trim().toLowerCase();
      const wantedEmployeeId = item.employee_id == null || item.employee_id === ""
        ? null
        : Number(item.employee_id);

      const allowed = getSelectableOutboundContactsForCustomer(customerId);

      const match = allowed.find((c) => {
        if (wantedType === "employee") {
          return c.contact_type === "employee" && Number(c.employee_id || 0) === Number(wantedEmployeeId || 0);
        }
        if (wantedType === "restaurant") {
          return c.contact_type === "restaurant";
        }
        return false;
      });

      if (!match) {
        skipped.push({ ...item, reason: "contact_not_found" });
        continue;
      }

      const already = existsStmt.get(
        customerId,
        match.employee_id,
        match.email
      );

      if (already) {
        skipped.push({
          customer_id: customerId,
          employee_id: match.employee_id,
          email: match.email,
          contact_type: match.contact_type,
          reason: "already_queued"
        });
        continue;
      }

      insertStmt.run(
        customerId,
        match.employee_id,
        match.restaurant_name,
        match.contact_name,
        match.email,
        match.contact_type,
        nowMs,
        nowMs
      );

      inserted.push({
        customer_id: customerId,
        restaurant_name: match.restaurant_name,
        employee_id: match.employee_id,
        contact_name: match.contact_name,
        email: match.email,
        contact_type: match.contact_type
      });
    }
  });

  tx(selections);

  return reply.send({
    ok: true,
    inserted_count: inserted.length,
    skipped_count: skipped.length,
    inserted,
    skipped
  });
});

fastify.get("/employees", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const q = String((req.query && req.query.q) || "").trim();
  const where = q ? "WHERE (full_name LIKE @q OR role LIKE @q OR stage LIKE @q OR status LIKE @q)" : "";
  const params = q ? { q: `%${q}%` } : {};

  const rows = db
    .prepare(
      `SELECT e.*,
              (SELECT COUNT(1) FROM employee_customers ec WHERE ec.employee_id = e.id) AS restaurant_count
       FROM employees e
       ${where}
       ORDER BY e.updated_at DESC, e.full_name ASC
       LIMIT 1000`
    )
    .all(params);

  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:800;font-size:18px">Employees</div>
        <div class="muted">People linked to restaurants</div>
      </div>
      <div class="row">
        <a class="btn" href="/employees/new">+ New employee</a>
      </div>
    </div>

    <form method="get" action="/employees" style="margin-top:12px" class="row">
      <div style="flex:1;min-width:240px">
        <label>Search</label>
        <input name="q" value="${esc(q)}" placeholder="name role stage status" />
      </div>
      <div style="align-self:flex-end">
        <button class="btn secondary" type="submit">Filter</button>
      </div>
    </form>

    <div style="margin-top:12px;overflow:auto">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Role</th>
            <th>Stage</th>
            <th>Status</th>
            <th>Restaurants</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map((e) => `
              <tr>
                <td><a href="/employees/${e.id}">${esc(e.full_name)}</a></td>
                <td>${esc(e.role || "—")}</td>
                <td>${esc(e.stage || "—")}</td>
                <td>${esc(e.status || "—")}</td>
                <td>${esc(String(e.restaurant_count || 0))}</td>
                <td><a class="btn secondary" href="/employees/${e.id}/edit">Edit</a></td>
              </tr>`)
            .join("")}
        </tbody>
      </table>
      ${rows.length === 0 ? `<div class="muted" style="margin-top:10px">No employees yet</div>` : ""}
    </div>
  </div>`;

  return reply.type("text/html").send(layout("Employees", body));
});

fastify.get("/employees/new", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const cs = allCustomersForPicklist();
  const e = {};

  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div style="font-weight:900;font-size:18px">New employee</div>
      <a class="btn secondary" href="/employees">Back</a>
<form method="POST" action="/employees/${e.id}/email/sync/outlook" style="margin-top:10px;"><button class="btn" type="submit">Sync Outlook Inbox</button></form>
    </div>

    <form method="post" action="/employees/new">
      <label>Full name</label>
      <input name="full_name" required />

      <label>First name</label>
      <input name="first_name" />

      <label>Role</label>
      <input name="role" />

      <label>LinkedIn URL</label>
      <input name="linkedin_url" />

      

      <label>Phone</label>
      <input name="phone" value="" inputmode="tel" autocomplete="tel" />

      <label>Personal Email</label>
      <input name="email" value="" type="email" autocomplete="email" />
<label>Stage</label>
<div style="display:flex;gap:10px;align-items:center">
  <span style="width:14px;height:14px;border-radius:999px;background:${({"New":"#d8b4fe","Connected":"#93c5fd","Replied":"#fde68a","Interested":"#e5e7eb","Call Booked":"#bbf7d0","Not Interested":"#fca5a5","No Response":"#e5e7eb","Closed Won":"#60a5fa"}[(e||{}).stage]||"#243041")};border:1px solid var(--line);flex:0 0 auto"></span>
  <select name="stage">
    <option value="">—</option>
    <option value="New" ${(e||{}).stage==="New"?"selected":""}>New</option>
    <option value="Connected" ${(e||{}).stage==="Connected"?"selected":""}>Connected</option>
    <option value="Replied" ${(e||{}).stage==="Replied"?"selected":""}>Replied</option>
    <option value="Interested" ${(e||{}).stage==="Interested"?"selected":""}>Interested</option>
    <option value="Call Booked" ${(e||{}).stage==="Call Booked"?"selected":""}>Call Booked</option>
    <option value="Not Interested" ${(e||{}).stage==="Not Interested"?"selected":""}>Not Interested</option>
    <option value="No Response" ${(e||{}).stage==="No Response"?"selected":""}>No Response</option>
    <option value="Closed Won" ${(e||{}).stage==="Closed Won"?"selected":""}>Closed Won</option>
  </select>
</div>

      <label>Status</label>
<div style="display:flex;gap:10px;align-items:center">
  <span style="width:14px;height:14px;border-radius:999px;background:${({"Waiting reply":"#fde68a","Follow-up today":"#fdba74","Follow-up later":"#93c5fd","Call booked":"#bbf7d0","Not interested":"#fca5a5"}[(e||{}).status]||"#243041")};border:1px solid var(--line);flex:0 0 auto"></span>
  <select name="status">
    <option value="">—</option>
    <option value="Waiting reply" ${(e||{}).status==="Waiting reply"?"selected":""}>Waiting reply</option>
    <option value="Follow-up today" ${(e||{}).status==="Follow-up today"?"selected":""}>Follow-up today</option>
    <option value="Follow-up later" ${(e||{}).status==="Follow-up later"?"selected":""}>Follow-up later</option>
    <option value="Call booked" ${(e||{}).status==="Call booked"?"selected":""}>Call booked</option>
    <option value="Not interested" ${(e||{}).status==="Not interested"?"selected":""}>Not interested</option>
  </select>
</div>

      <label>Last message sent</label>
      <input name="last_message_sent" placeholder="YYYY-MM-DD or free text" />

      <label>Next follow-up date</label>
      <input name="next_follow_up_date" placeholder="YYYY-MM-DD" />

      <label>Restaurants (select one or many)</label>
      <select name="customerIds" multiple size="8">
        ${cs.map(c => `<option value="${c.id}">${esc(c.name)}${c.town ? " • " + esc(c.town) : ""}</option>`).join("")}
      </select>

      <label>Notes</label>
      <textarea name="notes"></textarea>

      <div class="row" style="margin-top:12px;justify-content:flex-end">
        <button class="btn" type="submit">Save</button>
      </div>
    </form>
  </div>`;

  return reply.type("text/html").send(layout("New employee", body));
});

fastify.post("/employees/new", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const b = req.body || {};
  const full_name = String(b.full_name || "").trim();
  if (!full_name) return reply.redirect("/employees/new");

  const info = db.prepare(
    `INSERT INTO employees
      (full_name, first_name, role, linkedin_url, phone, email, stage, last_message_sent, next_follow_up_date, status, notes, created_at, updated_at)
     VALUES
      (@full_name, @first_name, @role, @linkedin_url, @phone, @email, @stage, @last_message_sent, @next_follow_up_date, @status, @notes, datetime('now'), datetime('now'))`
  ).run({
    full_name,
    first_name: String(b.first_name || "").trim(),
    role: String(b.role || "").trim(),
    linkedin_url: String(b.linkedin_url || "").trim(),
      phone: String(b.phone || "").trim(),
      email: String(b.email || "").trim(),
    stage: String(b.stage || "").trim(),
    last_message_sent: String(b.last_message_sent || "").trim(),
    next_follow_up_date: String(b.next_follow_up_date || "").trim(),
    status: String(b.status || "").trim(),
    notes: String(b.notes || "").trim(),
  });

  const employeeId = info.lastInsertRowid;

  const idsRaw = b.customerIds;
  const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw ? [idsRaw] : []);
  for (const id of ids) {
    const cid = Number(id);
    if (Number.isFinite(cid)) {
      db.prepare(`INSERT OR IGNORE INTO employee_customers (employee_id, customer_id) VALUES (?, ?)`).run(employeeId, cid);
    }
  }

  return reply.redirect(`/employees/${employeeId}`);
});

fastify.get("/employees/:id", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const e = db.prepare(`SELECT * FROM employees WHERE id=?`).get(id);
  if (!e) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const links = employeeCustomerLinks(id);
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div style="font-weight:900;font-size:22px">${esc(e.full_name)}</div>
        <div class="muted">${esc(e.role || "")}</div>
        <div class="row" style="margin-top:10px">
          ${e.linkedin_url ? `<a class="btn secondary" href="${esc(e.linkedin_url)}" target="_blank" rel="noopener noreferrer">LinkedIn</a>` : `<span class="btn secondary">No LinkedIn</span>`}
          <a class="btn secondary" href="/employees/${e.id}/edit">Edit</a>
        </div>
          <div class="row" style="margin-top:10px">
            ${e.phone ? `<a class="btn secondary" href="tel:${esc(e.phone)}">Call</a>` : `<span class="btn secondary">No phone</span>`}
            ${e.email ? `<a class="btn secondary" href="mailto:${esc(e.email)}">Email</a>` : `<span class="btn secondary">No email</span>`}
          </div>

          <div class="row" style="margin-top:12px">
            <div style="flex:1;min-width:240px">
              <div class="muted">Phone</div>
              <div>${esc(e.phone || "—")}</div>
            </div>
            <div style="flex:1;min-width:240px">
              <div class="muted">Personal Email</div>
              <div>${esc(e.email || "—")}</div>
            </div>
          </div>

      </div>
      <a class="btn secondary" href="/employees">Back</a>
<form method="POST" action="/employees/${e.id}/email/sync/outlook" style="margin-top:10px;"><button class="btn" type="submit">Sync Outlook Inbox</button></form>
    </div>

    <div class="row" style="margin-top:12px">
      <div style="flex:1;min-width:240px">
        <div class="muted">Stage</div>
        <div>${esc(e.stage || "—")}</div>
      </div>
      <div style="flex:1;min-width:240px">
        <div class="muted">Status</div>
        <div>${esc(e.status || "—")}</div>
      </div>
      <div style="flex:1;min-width:240px">
        <div class="muted">Next follow-up</div>
        <div>${esc(e.next_follow_up_date || "—")}</div>
      </div>
    </div>

    <div style="margin-top:12px">
      <div class="muted">Notes</div>
      <div style="white-space:pre-wrap;margin-top:6px">${esc(e.notes) || "<span class='muted'>—</span>"}</div>
    </div>

    <div style="display:grid;gap:12px;grid-template-columns: 1.2fr 0.8fr;margin-top:12px">
      <div></div>

      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div style="font-weight:800">Last email thread</div>
        </div>

        ${(() => {
          const last = db.prepare("SELECT type, note, email_body, email_subject, email_from, email_to, at FROM touchpoints WHERE employeeId=? AND type IN ('email_out','email_in') ORDER BY at DESC LIMIT 1").get(id);
          if (!last) return `<div class="muted" style="margin-top:10px">No emails logged yet</div>`;
          const when = last.at ? new Date(last.at * 1000).toISOString().replace("T"," ").slice(0,16) : "";
          const body = String(last.email_body || last.note || "").trim();
          const clipped = body.length > 3000 ? body.slice(0, 2990) + "..." : body;
          return `
            <div class="muted" style="margin-top:8px">${esc(when)} • ${esc(last.type || '')}</div>
            <details style="margin-top:10px">
              <summary class="muted" style="cursor:pointer">Show email</summary>
              <pre style="white-space:pre-wrap;margin:10px 0 0 0;border:1px solid var(--border);background:var(--panel);padding:10px;border-radius:10px">${esc(clipped)}</pre>
            </details>
          `;
        })()}
      </div>
    </div>

    <div style="margin-top:16px;border-top:1px solid var(--line);padding-top:14px">
      <div style="font-weight:800;margin-bottom:10px">Linked restaurants</div>
      ${links.length === 0 ? `<div class="muted">None yet</div>` : `<div class="row">${links.map(c => `<a class="pill" href="/customers/${c.id}">${esc(c.name)}${c.town ? " • " + esc(c.town) : ""}</a>`).join("")}</div>`}
    </div>
  </div>`;

  return reply.type("text/html").send(layout("Employee", body));
});

fastify.get("/employees/:id/edit", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const e = db.prepare(`SELECT * FROM employees WHERE id=?`).get(id);
  if (!e) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const links = employeeCustomerLinks(id).map(x => x.id);
  const cs = allCustomersForPicklist();

  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div style="font-weight:900;font-size:18px">Edit employee</div>
      <a class="btn secondary" href="/employees/${e.id}">Back</a>
<form method="POST" action="/employees/${e.id}/email/sync/outlook" style="margin-top:10px;"><button class="btn" type="submit">Sync Outlook Inbox</button></form>
    </div>

    <form method="post" action="/employees/${e.id}/edit">
      <label>Full name</label>
      <input name="full_name" required value="${esc(e.full_name)}" />

      <label>First name</label>
      <input name="first_name" value="${esc(e.first_name || "")}" />

      <label>Role</label>
      <input name="role" value="${esc(e.role || "")}" />

      <label>LinkedIn URL</label>
      <input name="linkedin_url" value="${esc(e.linkedin_url || "")}" />

      

      <label>Phone</label>
      <input name="phone" value="${esc(e.phone || "")}" inputmode="tel" autocomplete="tel" />

      <label>Personal Email</label>
      <input name="email" value="${esc(e.email || "")}" type="email" autocomplete="email" />
<label>Stage</label>
      <div style="display:flex;gap:10px;align-items:center">
  <span style="width:14px;height:14px;border-radius:999px;background:${({"New":"#d8b4fe","Connected":"#93c5fd","Replied":"#fde68a","Interested":"#e5e7eb","Call Booked":"#bbf7d0","Not Interested":"#fca5a5","No Response":"#e5e7eb","Closed Won":"#60a5fa"}[(e||{}).stage]||"#243041")};border:1px solid var(--line);flex:0 0 auto"></span>
  <select name="stage">
    <option value="">—</option>
    <option value="New" ${(e||{}).stage==="New"?"selected":""}>New</option>
    <option value="Connected" ${(e||{}).stage==="Connected"?"selected":""}>Connected</option>
    <option value="Replied" ${(e||{}).stage==="Replied"?"selected":""}>Replied</option>
    <option value="Interested" ${(e||{}).stage==="Interested"?"selected":""}>Interested</option>
    <option value="Call Booked" ${(e||{}).stage==="Call Booked"?"selected":""}>Call Booked</option>
    <option value="Not Interested" ${(e||{}).stage==="Not Interested"?"selected":""}>Not Interested</option>
    <option value="No Response" ${(e||{}).stage==="No Response"?"selected":""}>No Response</option>
    <option value="Closed Won" ${(e||{}).stage==="Closed Won"?"selected":""}>Closed Won</option>
  </select>
</div>

      <label>Status</label>
      <div style="display:flex;gap:10px;align-items:center">
  <span style="width:14px;height:14px;border-radius:999px;background:${({"Waiting reply":"#fde68a","Follow-up today":"#fdba74","Follow-up later":"#93c5fd","Call booked":"#bbf7d0","Not interested":"#fca5a5"}[(e||{}).status]||"#243041")};border:1px solid var(--line);flex:0 0 auto"></span>
  <select name="status">
    <option value="">—</option>
    <option value="Waiting reply" ${(e||{}).status==="Waiting reply"?"selected":""}>Waiting reply</option>
    <option value="Follow-up today" ${(e||{}).status==="Follow-up today"?"selected":""}>Follow-up today</option>
    <option value="Follow-up later" ${(e||{}).status==="Follow-up later"?"selected":""}>Follow-up later</option>
    <option value="Call booked" ${(e||{}).status==="Call booked"?"selected":""}>Call booked</option>
    <option value="Not interested" ${(e||{}).status==="Not interested"?"selected":""}>Not interested</option>
  </select>
</div>

      <label>Last message sent</label>
      <input name="last_message_sent" value="${esc(e.last_message_sent || "")}" />

      <label>Next follow-up date</label>
      <input name="next_follow_up_date" value="${esc(e.next_follow_up_date || "")}" />

      <label>Restaurants (select one or many)</label>
      <select name="customerIds" multiple size="10">
        ${cs.map(c => {
          const sel = links.includes(c.id) ? " selected" : "";
          return `<option value="${c.id}"${sel}>${esc(c.name)}${c.town ? " • " + esc(c.town) : ""}</option>`;
        }).join("")}
      </select>

      <label>Notes</label>
      <textarea name="notes">${esc(e.notes || "")}</textarea>

      <div class="row" style="margin-top:12px;justify-content:flex-end">
        <button class="btn" type="submit">Save</button>
          <button class="btn danger" type="submit" formaction="/employees/${e.id}/delete" formmethod="post" onclick="return confirm('Delete this employee?' )">Delete</button>
      </div>
    </form>
  </div>`;

  return reply.type("text/html").send(layout("Edit employee", body));
});

fastify.post("/employees/:id/edit", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  const e = db.prepare(`SELECT id FROM employees WHERE id=?`).get(id);
  if (!e) return reply.code(404).type("text/html").send(layout("Not found", `<div class="card">Not found</div>`));

  const b = req.body || {};
  const full_name = String(b.full_name || "").trim();
  if (!full_name) return reply.redirect(`/employees/${id}/edit`);

  db.prepare(
    `UPDATE employees
     SET phone=@phone, email=@email, full_name=@full_name, first_name=@first_name, role=@role, linkedin_url=@linkedin_url,
         stage=@stage, last_message_sent=@last_message_sent, next_follow_up_date=@next_follow_up_date,
         status=@status, notes=@notes, updated_at=datetime('now')
     WHERE id=@id`
  ).run({
    id,
    full_name,
    first_name: String(b.first_name || "").trim(),
    role: String(b.role || "").trim(),
    linkedin_url: String(b.linkedin_url || "").trim(),
      phone: String(b.phone || "").trim(),
      email: String(b.email || "").trim(),
      phone: String(b.phone || "").trim(),
      email: String(b.email || "").trim(),
    stage: String(b.stage || "").trim(),
    last_message_sent: String(b.last_message_sent || "").trim(),
    next_follow_up_date: String(b.next_follow_up_date || "").trim(),
    status: String(b.status || "").trim(),
    notes: String(b.notes || "").trim(),
  });  db.prepare(`DELETE FROM employee_customers WHERE employee_id=?`).run(id);

  const idsRaw = b.customerIds;
  const ids = Array.isArray(idsRaw) ? idsRaw : (idsRaw ? [idsRaw] : []);
  for (const cidRaw of ids) {
    const cid = Number(cidRaw);
    if (Number.isFinite(cid)) {
      db.prepare(`INSERT OR IGNORE INTO employee_customers (employee_id, customer_id) VALUES (?, ?)`).run(id, cid);
    }
  }

  return reply.redirect(`/employees/${id}`);
});

fastify.post("/employees/:id/delete", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const id = Number(req.params.id);
  db.prepare("DELETE FROM employee_customers WHERE employee_id=?").run(id);
  db.prepare("DELETE FROM employees WHERE id=?").run(id);
  return reply.redirect("/employees");
});

// CRM_OPENAI_LEAD_ENGINE_EMAIL_DRAFT_V1
// AI Email now drafts a Lead Engine / Target Pipeline outreach preview only. It never sends email.
fastify.get('/customers/:id/email/ai', async (req, reply) => {
  try {
    const customerId = Number(req.params.id);
    if (!customerId) return reply.code(400).send('Bad customer id');

    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    if (!customer) return reply.code(404).send('Customer not found');

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
    if (!OPENAI_API_KEY) {
      const body = `
        <div class="card">
          <h2 style="margin:0 0 8px 0">AI Email Draft</h2>
          <div class="muted">Customer: ${esc(customer.business || customer.name || ('#' + customer.id))}</div>
          <div style="margin-top:10px">Missing <code>OPENAI_API_KEY</code> env var. No draft was generated.</div>
          <div style="margin-top:12px"><a class="btn secondary" href="/customers/${customer.id}">Back</a></div>
        </div>`;
      return reply.type("text/html").send(layout("AI Email Draft", body));
    }

    const recentTouchpoints = db.prepare(`
      SELECT type, note, email_body, email_subject, email_from, email_to, at
      FROM touchpoints
      WHERE customerId = ? AND type IN ('email_out','email_in','note')
      ORDER BY at DESC
      LIMIT 5
    `).all(customerId) || [];

    const history = recentTouchpoints.map(tp => ({
      type: String(tp.type || '').trim(),
      at: tp.at ? new Date(tp.at * 1000).toISOString().slice(0, 10) : '',
      subject: String(tp.email_subject || '').trim(),
      note_or_body: String(tp.email_body || tp.note || '').trim().slice(0, 800),
      from: String(tp.email_from || '').trim(),
      to: String(tp.email_to || '').trim()
    })).filter(tp => tp.note_or_body || tp.subject);

    const leadEngineContext = {
      id: customer.id,
      name: customer.name || '',
      business: customer.business || customer.name || '',
      email: customer.email || '',
      phone: customer.phone || '',
      town: customer.town || '',
      website: customer.website || '',
      tags: customer.tags || '',
      notes: customer.notes || '',
      target_status: customer.target_status || '',
      lead_source: customer.lead_source || '',
      lead_industry: customer.lead_industry || '',
      outreach_status: customer.outreach_status || '',
      next_follow_up_at: customer.next_follow_up_at || '',
      pipeline_notes: customer.pipeline_notes || '',
      recent_touchpoints: history
    };

    const prompt = [
      'Draft one concise UK cold outreach email for Frontline AI.',
      'Use the stored CRM and Lead Engine context only. Do not invent facts, names, reviews, or technologies.',
      'Write as Frontline AI / we / our offering. Do not write as "I build".',
      'Mention that Frontline AI offers managed AI services and custom builds only where it sounds natural.',
      'Avoid generic AI marketing language. Make the observation specific and practical.',
      'Do not say "This is not about replacing staff."',
      'The email must be a preview draft only, not a send instruction.',
      'Keep the body concise enough for cold outreach: 90-150 words.',
      'Use this structure: Subject, greeting, specific observation, practical Frontline AI use case, soft CTA, sign off as Frontline AI.',
      'If the notes include a Suggested opener or Sales reason, use that as the strongest evidence.',
      'For garages/MOT leads, prefer missed calls, after-hours MOT/service enquiries, phone-led booking, and follow-up wording when supported by the data.',
      'Return strict JSON only with keys: subject, body, evidence_used.'
    ].join('\n');

    const payload = JSON.stringify({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify(leadEngineContext) }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'frontline_ai_email_draft',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              subject: { type: 'string' },
              body: { type: 'string' },
              evidence_used: { type: 'array', items: { type: 'string' } }
            },
            required: ['subject', 'body', 'evidence_used']
          }
        }
      }
    });

    const https = require('https');
    const aiRaw = await new Promise((resolve, reject) => {
      const req2 = https.request({
        method: 'POST',
        hostname: 'api.openai.com',
        path: '/v1/responses',
        headers: {
          'Authorization': 'Bearer ' + OPENAI_API_KEY,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error('OpenAI ' + res.statusCode + ': ' + data.slice(0, 500)));
          resolve(data);
        });
      });
      req2.on('error', reject);
      req2.setTimeout(30000, () => req2.destroy(new Error('OpenAI timeout')));
      req2.write(payload);
      req2.end();
    });

    let outputText = '';
    const parsed = JSON.parse(aiRaw);
    if (parsed.output_text) outputText = String(parsed.output_text).trim();
    if (!outputText && Array.isArray(parsed.output)) {
      for (const item of parsed.output) {
        for (const c of (item.content || [])) {
          if (c.type === 'output_text' && c.text) {
            outputText = String(c.text).trim();
            break;
          }
        }
        if (outputText) break;
      }
    }
    if (!outputText) throw new Error('OpenAI returned no draft text');

    const draft = JSON.parse(outputText);
    const subject = String(draft.subject || '').trim();
    const draftBody = String(draft.body || '').trim();
    if (!subject || !draftBody) throw new Error('OpenAI returned an incomplete draft');

    const to = String(customer.email || '').trim();
    const mailto = to
      ? 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(draftBody)
      : '';
    const evidence = Array.isArray(draft.evidence_used) ? draft.evidence_used.map(v => String(v || '').trim()).filter(Boolean) : [];

    const wantsJson = String((req.headers && req.headers.accept) || '').includes('application/json')
      || String((req.query && req.query.format) || '') === 'json';
    if (wantsJson) {
      return reply.send({ ok: true, customerId: customer.id, subject, body: draftBody, evidence_used: evidence, to });
    }

    const body = `
      <div class="card" style="margin-bottom:12px">
        <h2 style="margin:0 0 8px 0">AI Email Draft</h2>
        <div class="muted">Draft preview only. Nothing has been sent.</div>
        <div class="muted" style="margin-top:6px">Customer: ${esc(customer.business || customer.name || ('#' + customer.id))}</div>
        <div class="muted">Industry: ${esc(customer.lead_industry || '—')} • Status: ${esc(targetStatusLabel(customer.target_status || ''))}</div>
        <div style="margin-top:12px"><a class="btn secondary" href="/customers/${customer.id}">Back</a></div>
      </div>
      <div class="card">
        <div><b>To</b> ${to ? `<a href="mailto:${esc(to)}">${esc(to)}</a>` : '<span class="muted">No email saved yet</span>'}</div>
        <div style="margin-top:8px"><b>Subject</b> ${esc(subject)}</div>
        <pre style="white-space:pre-wrap;margin:12px 0 0 0;border:1px solid var(--line);background:#0e1522;padding:14px;border-radius:14px">${esc(draftBody)}</pre>
        ${evidence.length ? `<div style="margin-top:14px"><b>Evidence used</b><ul>${evidence.map(v => `<li>${esc(v)}</li>`).join('')}</ul></div>` : ''}
        <div class="row" style="margin-top:14px;justify-content:flex-end;gap:8px">
          ${mailto ? `<a class="btn" href="${esc(mailto)}">Open mailto draft</a>` : ''}
          <button class="btn secondary" type="button" onclick="copyDraft()">Copy draft</button>
        </div>
        <textarea id="ai_email_copy" style="position:absolute;left:-9999px;top:-9999px">${esc(`Subject: ${subject}\n\n${draftBody}`)}</textarea>
      </div>
      <script>
        async function copyDraft(){
          var el = document.getElementById('ai_email_copy');
          var v = (el && el.value) ? el.value : '';
          try {
            await navigator.clipboard.writeText(v);
            alert('Copied');
          } catch(e) {
            el.select();
            document.execCommand('copy');
            alert('Copied');
          }
        }
      </script>`;

    return reply.type("text/html").send(layout("AI Email Draft", body));
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send('AI email error: ' + (err.message || err));
  }
});

// MCR_OUTLOOK_SYNC_ROUTE_V1
/* =========================
   Outlook inbox sync (last 50)
   Saves into touchpoints with external_provider='outlook' and external_id=Graph message id
   ========================= */

function outlookGetTokenRow(){
  return db.prepare("SELECT * FROM oauth_tokens WHERE provider='microsoft'").get();
}
function outlookSaveTokenRow(t){
  db.prepare(`
    INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
    VALUES ('microsoft', @access_token, @refresh_token, @expires_at)
  `).run(t);
}
function outlookNowSec(){ return Math.floor(Date.now()/1000); }

async function outlookRefreshIfNeeded(){
  const t = outlookGetTokenRow();
  if (!t || !t.refresh_token) throw new Error("Microsoft not connected");
  const exp = Number(t.expires_at || 0);
  if (exp && (exp - 60) > outlookNowSec()) return String(t.access_token || "");

  const tenant = process.env.MS_TENANT_ID || "";
  const client = process.env.MS_CLIENT_ID || "";
  const secret = process.env.MS_CLIENT_SECRET || "";
  const redirect = process.env.MS_REDIRECT_URI || "";
  if (!tenant || !client || !secret || !redirect) throw new Error("Missing MS_* env vars");

  const postData =
    `client_id=${encodeURIComponent(client)}` +
    `&scope=${encodeURIComponent("https://graph.microsoft.com/Mail.ReadWrite offline_access")}` +
    `&refresh_token=${encodeURIComponent(String(t.refresh_token||""))}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&grant_type=refresh_token` +
    `&client_secret=${encodeURIComponent(secret)}`;

  const https = require("https");
  const token = await new Promise((resolve, reject) => {
    const req2 = https.request({
      method: "POST",
      hostname: "login.microsoftonline.com",
      path: `/${tenant}/oauth2/v2.0/token`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("MS_REFRESH_ERROR " + res.statusCode + " " + data));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("MS_REFRESH_PARSE_ERROR " + data.slice(0, 300))); }
      });
    });
    req2.on("error", reject);
    req2.setTimeout(30000, () => req2.destroy(new Error("MS_REFRESH_TIMEOUT")));
    req2.write(postData);
    req2.end();
  });

  outlookSaveTokenRow({
    access_token: String(token.access_token || ""),
    refresh_token: String(token.refresh_token || t.refresh_token || ""),
    expires_at: outlookNowSec() + Number(token.expires_in || 0),
  });

  return String(token.access_token || "");
}

async function outlookGraphGetJson(path){
  const token = await outlookRefreshIfNeeded();
  const https = require("https");
  return await new Promise((resolve, reject) => {
    const req2 = https.request({
      method: "GET",
      hostname: "graph.microsoft.com",
      path,
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("GRAPH_ERROR " + res.statusCode + " " + data));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("GRAPH_PARSE_ERROR " + data.slice(0, 300))); }
      });
    });
    req2.on("error", reject);
    req2.setTimeout(30000, () => req2.destroy(new Error("GRAPH_TIMEOUT")));
    req2.end();
  });
}

async function outlookGraphPostJson(path, payload){
  const token = await outlookRefreshIfNeeded();
  const https = require("https");
  const body = JSON.stringify(payload || {});
  return await new Promise((resolve, reject) => {
    const req2 = https.request({
      method: "POST",
      hostname: "graph.microsoft.com",
      path,
      headers: {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("GRAPH_ERROR " + res.statusCode + " " + data));
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req2.on("error", reject);
    req2.setTimeout(30000, () => req2.destroy(new Error("GRAPH_TIMEOUT")));
    req2.write(body);
    req2.end();
  });
}


function outlookPickAddr(obj){
  try{
    return String((((obj||{}).emailAddress||{}).address)||"").trim().toLowerCase();
  }catch(_){ return ""; }
}

fastify.post("/customers/:id/email/sync/outlook", async (req, reply) => {
  try{
    if (!requireAuth(req, reply)) return;
    const customerId = Number(req.params.id);
    if (!customerId) return reply.code(400).send("Bad customer id");
    const customer = db.prepare("SELECT * FROM customers WHERE id=?").get(customerId);
    if (!customer) return reply.code(404).send("Customer not found");
    const custEmail = String(customer.email||"").trim().toLowerCase();
    if (!custEmail) return reply.code(400).send("Customer has no email saved");
    const myEmail = "gary@missedcallsrecovered.co.uk";
    const sel = encodeURIComponent("id,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,conversationId");
    const path = `/v1.0/me/messages?$top=50&$orderby=receivedDateTime%20desc&$select=${sel}`;
    const data = await outlookGraphGetJson(path);
    const msgs = (data && data.value) ? data.value : [];
    const existsStmt = db.prepare("SELECT 1 FROM touchpoints WHERE external_provider='outlook' AND external_id=? LIMIT 1");
    const insStmt = db.prepare(`
      INSERT INTO touchpoints
        (customerId, type, note, email_body, email_subject, email_from, email_to, at,
         external_provider, external_id, external_thread_id, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'outlook', ?, ?, ?)
    `);
    let inserted = 0;
    for (const m of msgs){
      const mid = String(m.id||"").trim();
      if (!mid) continue;
      if (existsStmt.get(mid)) continue;
      const subj = String(m.subject||"").trim();
      const body = htmlToText((((m.body||{}).content)||""));
      const fromAddr = outlookPickAddr(m.from);
      const toList = (m.toRecipients||[]).map(outlookPickAddr).filter(Boolean);
      const ccList = (m.ccRecipients||[]).map(outlookPickAddr).filter(Boolean);
      const participants = [fromAddr,...toList,...ccList].map(x=>String(x||"").toLowerCase());
      if (!participants.includes(custEmail)) continue;
      let typ = "email_in";
      if (fromAddr === myEmail) typ = "email_out";
      else if (fromAddr === custEmail) typ = "email_in";
      const whenIso = String(m.receivedDateTime||m.sentDateTime||"").trim();
      const whenSec = whenIso ? Math.floor(Date.parse(whenIso)/1000) : Math.floor(Date.now()/1000);
      const note = subj ? ("Subject: " + subj) : "";
      const isRead = (m.isRead === false) ? 0 : 1;
      const threadId = String(m.conversationId||"").trim();
      insStmt.run(customerId, typ, note, body, subj, fromAddr, toList.join(" "), whenSec, mid, threadId, isRead);
      inserted += 1;
    }
    reply.raw.statusCode=303; reply.raw.setHeader("Location","/customers/"+customerId); reply.raw.end(); return;
  }catch(e){
    try{ req.log.error(e); }catch(_){}
    return reply.code(500).send({ ok:false, error: String(e.message||e) });
  }
});

fastify.post("/employees/:id/email/sync/outlook", async (req, reply) => {
  try{
    if (!requireAuth(req, reply)) return;
    const employeeId = Number(req.params.id);
    if (!employeeId) return reply.code(400).send("Bad employee id");
    const employee = db.prepare("SELECT * FROM employees WHERE id=?").get(employeeId);
    if (!employee) return reply.code(404).send("Employee not found");
    const empEmail = String(employee.email||"").trim().toLowerCase();
    if (!empEmail) return reply.code(400).send("Employee has no email saved");
    const myEmail = "gary@missedcallsrecovered.co.uk";
    const systemCustomer = db.prepare("SELECT id FROM customers WHERE name='__EMPLOYEE_EMAIL_THREAD__' LIMIT 1").get();
    if (!systemCustomer) return reply.code(500).send({ ok:false, error: "System customer missing: __EMPLOYEE_EMAIL_THREAD__" });
    const sel = encodeURIComponent("id,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,conversationId");
    const path = `/v1.0/me/messages?$top=50&$orderby=receivedDateTime%20desc&$select=${sel}`;
    const data = await outlookGraphGetJson(path);
    const msgs = (data && data.value) ? data.value : [];
    const existsStmt = db.prepare("SELECT 1 FROM touchpoints WHERE external_provider='outlook' AND external_id=? LIMIT 1");
    const insStmt = db.prepare(`
      INSERT INTO touchpoints
        (customerId, employeeId, type, note, email_body, email_subject, email_from, email_to, at,
         external_provider, external_id, external_thread_id, is_read)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'outlook', ?, ?, ?)
    `);
    let inserted = 0;
    for (const m of msgs){
      const mid = String(m.id||"").trim();
      if (!mid) continue;
      if (existsStmt.get(mid)) continue;
      const subj = String(m.subject||"").trim();
      const body = htmlToText((((m.body||{}).content)||""));
      const fromAddr = outlookPickAddr(m.from);
      const toList = (m.toRecipients||[]).map(outlookPickAddr).filter(Boolean);
      const ccList = (m.ccRecipients||[]).map(outlookPickAddr).filter(Boolean);
      const participants = [fromAddr,...toList,...ccList].map(x=>String(x||"").toLowerCase());
      if (!participants.includes(empEmail)) continue;
      let typ = "email_in";
      if (fromAddr === myEmail) typ = "email_out";
      else if (fromAddr === empEmail) typ = "email_in";
      const whenIso = String(m.receivedDateTime||m.sentDateTime||"").trim();
      const whenSec = whenIso ? Math.floor(Date.parse(whenIso)/1000) : Math.floor(Date.now()/1000);
      const note = subj ? ("Subject: " + subj) : "";
      const isRead = (m.isRead === false) ? 0 : 1;
      const threadId = String(m.conversationId||"").trim();
      insStmt.run(systemCustomer.id, employeeId, typ, note, body, subj, fromAddr, toList.join(" "), whenSec, mid, threadId, isRead);
      inserted += 1;
    }
    reply.raw.statusCode=303; reply.raw.setHeader("Location","/employees/"+employeeId); reply.raw.end(); return;
  }catch(e){
    try{ req.log.error(e); }catch(_){}
    return reply.code(500).send({ ok:false, error: String(e.message||e) });
  }
});

fastify.get("/debug/outlook/me", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  try {
    const data = await outlookGraphGetJson("/v1.0/me");
    return reply.send(data);
  } catch (e) {
    return reply.code(500).send({error:String(e.message||e)});
  }
});

function buildOutboundDraft(row) {
  const restaurantName = String(row.restaurant_name || '').trim() || 'your restaurant';
  const hasName = !!String(row.contact_name || '').trim();

  const subject = `Turn missed calls into bookings + a marketing list`;

  const body = hasName
    ? `Hi ${row.contact_name.trim()},

Quick one — when a call comes in for a same-day booking and no one answers, what happens to it?

Most of the time it’s just lost.

We’ve built a system that turns missed calls into both immediate bookings and future revenue for ${restaurantName}:

- missed calls are captured instantly
- same-day booking requests are taken automatically
- each request appears on a live shared board for your team
- staff can pick up, own, and complete each enquiry
- non-urgent calls are handled by SMS instead

And importantly:

- every caller becomes part of your future marketing list
- you can send SMS campaigns to past callers
- you can route them into a WhatsApp group for ongoing offers

So instead of:
missed call = lost booking

It becomes:
missed call → booking + long-term customer

Worth a quick look? Takes 5 minutes.

Gary`
    : `For the attention of whoever is responsible for bookings, service and revenue at ${restaurantName},

Quick one — when a call comes in for a same-day booking and no one answers, what happens to it?

Most of the time it’s just lost.

We’ve built a system that turns missed calls into both immediate bookings and future revenue for ${restaurantName}:

- missed calls are captured instantly
- same-day booking requests are taken automatically
- each request appears on a live shared board for your team
- staff can pick up, own, and complete each enquiry
- non-urgent calls are handled by SMS instead

And importantly:

- every caller becomes part of your future marketing list
- you can send SMS campaigns to past callers
- you can route them into a WhatsApp group for ongoing offers

So instead of:
missed call = lost booking

It becomes:
missed call → booking + long-term customer

Worth a quick look? Takes 5 minutes.

Gary`;

    const signature = `

`;

  const finalBody = body + signature;

return { subject, body: finalBody };
}

function getOutboundQueueRows() {
  return db.prepare(`
    SELECT
      oq.id,
      oq.restaurant_name,
      oq.contact_name,
      oq.email,
      oq.contact_type,
      oq.status,
      oq.step,
      oq.sequence_total,
      oq.created_at,
      oq.draft_subject,
      oq.draft_body,
      oq.draft_generated_at,
      oq.draft_reviewed_at,
      c.town
    FROM mc.outbound_queue oq
    LEFT JOIN customers c ON c.id = oq.restaurant_id
    ORDER BY oq.created_at DESC, oq.id DESC
  `).all();
}

fastify.post('/api/outbound/save-draft/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!id) return reply.code(400).send({ ok:false, error:'invalid id' });

  const row = db.prepare(`
    SELECT id
    FROM outbound_queue
    WHERE id=?
  `).get(id);

  if (!row) return reply.code(404).send({ ok:false, error:'not found' });

  const subject = String((req.body && req.body.subject) || '').trim();
  const body = String((req.body && req.body.body) || '').trim();

  if (!subject || !body) {
    return reply.code(400).send({ ok:false, error:'subject and body required' });
  }

  const now = Date.now();

  db.prepare(`
    UPDATE outbound_queue
    SET
      draft_subject=?,
      draft_body=?,
      draft_generated_at=COALESCE(draft_generated_at, ?),
      updated_at=?
    WHERE id=?
  `).run(subject, body, now, now, id);

  return reply.send({ ok:true, id });
});

fastify.post('/api/outbound/clear-draft/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!id) return reply.code(400).send({ ok:false, error:'invalid id' });

  const row = db.prepare(`
    SELECT id
    FROM outbound_queue
    WHERE id=?
  `).get(id);

  if (!row) return reply.code(404).send({ ok:false, error:'not found' });

  const now = Date.now();

  db.prepare(`
    UPDATE outbound_queue
    SET
      draft_subject=NULL,
      draft_body=NULL,
      draft_generated_at=NULL,
      draft_reviewed_at=NULL,
      updated_at=?
    WHERE id=?
  `).run(now, id);

  return reply.send({ ok:true, id });
});

fastify.post('/api/outbound/generate-drafts-all', async (req, reply) => {
  const rows = db.prepare(`
    SELECT id, restaurant_name, contact_name, email
    FROM outbound_queue
    WHERE COALESCE(email,'') <> ''
      AND (
        draft_subject IS NULL OR TRIM(draft_subject) = ''
        OR draft_body IS NULL OR TRIM(draft_body) = ''
      )
    ORDER BY id ASC
  `).all();

  const now = Date.now();

  const updateStmt = db.prepare(`
    UPDATE outbound_queue
    SET
      draft_subject=?,
      draft_body=?,
      draft_generated_at=?,
      updated_at=?,
      status='pending'
    WHERE id=?
  `);

  let generated = 0;

  for (const row of rows) {
    const { subject, body } = buildOutboundDraft(row);
    updateStmt.run(subject, body, now, now, row.id);
    generated += 1;
  }

  return reply.send({
    ok: true,
    generated,
    skipped_existing: 0
  });
});

fastify.post('/api/outbound/generate-draft/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!id) return reply.code(400).send({ ok:false, error:'invalid id' });

  const row = db.prepare(`
    SELECT id, restaurant_name, contact_name, email
    FROM outbound_queue
    WHERE id=?
  `).get(id);

  if (!row) return reply.code(404).send({ ok:false, error:'not found' });

  const { subject, body } = buildOutboundDraft(row);
  const now = Date.now();

  db.prepare(`
    UPDATE outbound_queue
    SET
      draft_subject=?,
      draft_body=?,
      draft_generated_at=?,
      updated_at=?,
      status='pending'
    WHERE id=?
  `).run(subject, body, now, now, id);

  return reply.send({
    ok: true,
    id,
    subject,
    body
  });
});

fastify.get('/api/outbound/outlook-link/:id', async (req, reply) => {
  const id = Number(req.params.id);
  if (!id) return reply.code(400).send({ ok:false, error:'invalid id' });

  const row = db.prepare(`
    SELECT id, email, draft_subject, draft_body
    FROM outbound_queue
    WHERE id=?
  `).get(id);

  if (!row) return reply.code(404).send({ ok:false, error:'not found' });
  if (!row.email || !String(row.email).trim()) {
    return reply.code(400).send({ ok:false, error:'missing email' });
  }
  if (!row.draft_subject || !String(row.draft_subject).trim() || !row.draft_body || !String(row.draft_body).trim()) {
    return reply.code(400).send({ ok:false, error:'draft missing' });
  }

  const url =
    'mailto:' + encodeURIComponent(String(row.email).trim()) +
    '?subject=' + encodeURIComponent(String(row.draft_subject)) +
    '&body=' + encodeURIComponent(String(row.draft_body));

  return reply.send({ ok:true, id, url });
});

fastify.post('/api/outbound/clear-drafts-all', async (req, reply) => {
  const now = Date.now();

  const res = db.prepare(`
    UPDATE outbound_queue
    SET
      draft_subject=NULL,
      draft_body=NULL,
      draft_generated_at=NULL,
      draft_reviewed_at=NULL,
      updated_at=?
    WHERE
      draft_subject IS NOT NULL
      OR draft_body IS NOT NULL
  `).run(now);

  return reply.send({
    ok: true,
    cleared: res.changes || 0
  });
});

fastify.get('/api/outbound/outlook-links-all', async (req, reply) => {
  const rows = db.prepare(`
    SELECT id, email, draft_subject, draft_body
    FROM outbound_queue
    WHERE COALESCE(email,'') <> ''
      AND COALESCE(draft_subject,'') <> ''
      AND COALESCE(draft_body,'') <> ''
    ORDER BY id ASC
  `).all();

  const urls = rows.map(row => ({
    id: row.id,
    email: row.email,
    url:
      'mailto:' + encodeURIComponent(String(row.email).trim()) +
      '?subject=' + encodeURIComponent(String(row.draft_subject || '')) +
      '&body=' + encodeURIComponent(String(row.draft_body || ''))
  }));

  return reply.send({ ok:true, count: urls.length, urls });
});

fastify.post('/api/outbound/create-outlook-drafts-all', async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const rows = db.prepare(`
    SELECT id, email, draft_subject, draft_body
    FROM outbound_queue
    WHERE COALESCE(email,'') <> ''
      AND COALESCE(draft_subject,'') <> ''
      AND COALESCE(draft_body,'') <> ''
    ORDER BY id ASC
  `).all();

  let created = 0;
  const errors = [];

  for (const row of rows) {
    try {
      await outlookGraphPostJson('/v1.0/me/messages', {
        subject: String(row.draft_subject || ''),
        body: {
          contentType: 'Text',
          content: String(row.draft_body || '')
        },
        toRecipients: [
          {
            emailAddress: {
              address: String(row.email || '').trim()
            }
          }
        ]
      });
      created += 1;
    } catch (e) {
      errors.push({
        id: row.id,
        email: row.email,
        error: String((e && e.message) || e || 'unknown')
      });
    }
  }

  return reply.send({
    ok: errors.length === 0,
    created,
    failed: errors.length,
    errors
  });
});

fastify.get("/outbound/queue", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const rows = getOutboundQueueRows();

  const body = `
  <div class="card" style="background:linear-gradient(180deg,#ffffff 0%,#f8fbff 100%);border:1px solid rgba(148,163,184,.22);box-shadow:0 18px 50px rgba(15,23,42,.10);color:#0f172a;">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div>
        <div style="font-weight:800;font-size:18px">Queued Openers</div>
        <div class="muted" style="color:#5b6474;">All contacts currently in the opener queue.</div>
      </div>
      <div class="row" style="gap:10px;">
        <button
          type="button"
          onclick="generateAllDrafts()"
          style="padding:10px 14px;border-radius:10px;border:1px solid rgba(125,162,255,.35);background:linear-gradient(180deg, rgba(70,110,255,.20), rgba(70,110,255,.10));color:#dbe6ff;cursor:pointer;font-weight:800;"
        >Generate drafts for all</button>
        <button
          type="button"
          onclick="clearAllDrafts()"
          style="padding:10px 14px;border-radius:10px;border:1px solid rgba(255,120,120,.35);background:rgba(120,20,20,.18);color:#ffd7d7;cursor:pointer;font-weight:800;"
        >Clear all</button>
        <button
          type="button"
          onclick="openAllDraftEmails()"
          style="padding:10px 14px;border-radius:10px;border:1px solid rgba(125,162,255,.35);background:linear-gradient(180deg, rgba(70,110,255,.20), rgba(70,110,255,.10));color:#dbe6ff;cursor:pointer;font-weight:800;"
        >Create all Outlook drafts</button>
        <a class="btn secondary" href="/outbound/openers">Back to openers</a>
      </div>
    </div>

    <script>
      function toggleDraftEditor(queueId){
        const box = document.getElementById('draft-editor-' + queueId);
        if(!box) return;
        box.style.display = box.style.display === 'none' ? 'block' : 'none';
      }

      
      async function clearAllDrafts(){
        if(!confirm('Clear ALL drafts?')) return;
        try{
          const res = await fetch('/api/outbound/clear-drafts-all', { method:'POST' });
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          location.reload();
        }catch(err){
          alert('Error clearing drafts');
        }
      }

async function generateAllDrafts(){
        try{
          const res = await fetch('/api/outbound/generate-drafts-all', { method:'POST' });
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          location.reload();
        }catch(err){
          alert('Error generating all drafts');
        }
      }

      async function openOutlookDraft(queueId){
        try{
          const res = await fetch('/api/outbound/outlook-link/' + queueId);
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          window.location.href = j.url;
        }catch(err){
          alert('Error opening Outlook compose');
        }
      }

      async function openAllDraftEmails(){
        try{
          const res = await fetch('/api/outbound/create-outlook-drafts-all', { method:'POST' });
          const j = await res.json();
          if(!j.ok && !j.created){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          if (j.failed && j.failed > 0) {
            alert('Created ' + (j.created || 0) + ' Outlook drafts. Failed: ' + j.failed);
            return;
          }
          alert('Created ' + (j.created || 0) + ' Outlook drafts');
        }catch(err){
          alert('Error creating Outlook drafts');
        }
      }

      async function generateDraft(queueId){
        try{
          const res = await fetch('/api/outbound/generate-draft/' + queueId, { method:'POST' });
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          location.reload();
        }catch(err){
          alert('Error generating draft');
        }
      }

      async function clearDraft(queueId){
        try{
          const res = await fetch('/api/outbound/clear-draft/' + queueId, { method:'POST' });
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          location.reload();
        }catch(err){
          alert('Error clearing draft');
        }
      }

      async function saveDraft(queueId){
        const subjectEl = document.getElementById('draft-subject-' + queueId);
        const bodyEl = document.getElementById('draft-body-' + queueId);
        if(!subjectEl || !bodyEl){
          alert('Draft editor not found');
          return;
        }

        const payload = new URLSearchParams();
        payload.set('subject', subjectEl.value || '');
        payload.set('body', bodyEl.value || '');

        try{
          const res = await fetch('/api/outbound/save-draft/' + queueId, {
            method:'POST',
            headers:{ 'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8' },
            body: payload.toString()
          });
          const j = await res.json();
          if(!j.ok){
            alert('Failed: ' + (j.error || 'unknown'));
            return;
          }
          location.reload();
        }catch(err){
          alert('Error saving draft');
        }
      }
    </script>

    <style>
      .queueSkinTweaks table{width:100%;border-collapse:separate;border-spacing:0;background:#ffffff;border:1px solid rgba(148,163,184,.20);border-radius:16px;overflow:hidden}
      .queueSkinTweaks thead th{background:linear-gradient(180deg,#eef4ff 0%,#e7eefc 100%);color:#334155;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;border-bottom:1px solid rgba(148,163,184,.22);padding:12px 14px}
      .queueSkinTweaks tbody td{background:#ffffff;color:#0f172a;padding:14px;border-bottom:1px solid rgba(226,232,240,.9);vertical-align:top}
      .queueSkinTweaks tbody tr:hover td{background:#f8fbff}
      .queueSkinTweaks input,.queueSkinTweaks textarea{background:#ffffff !important;color:#0f172a !important;border:1px solid rgba(148,163,184,.35) !important}
      .queueSkinTweaks input::placeholder,.queueSkinTweaks textarea::placeholder{color:#94a3b8}
    </style>
    <div class="queueSkinTweaks" style="margin-top:16px;overflow:auto">
      <table>
        <thead>
          <tr>
            <th>Restaurant</th>
            <th>Town</th>
            <th>Contact</th>
            <th>Email</th>
            <th>Type</th>
            <th>Status</th>
            <th>Step</th>
            <th>Draft</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${esc(r.restaurant_name || "")}</td>
              <td>${esc(r.town || "")}</td>
              <td>${esc(r.contact_name || "—")}</td>
              <td>${esc(r.email || "")}</td>
              <td>${esc(r.contact_type || "")}</td>
              <td>${esc(r.status || "")}</td>
              <td>${esc(String(r.step || 0))}</td>
              <td>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                  <button
                    type="button"
                    onclick="openOutlookDraft(${Number(r.id)})"
                    style="padding:6px 10px;border-radius:8px;border:1px solid rgba(125,162,255,.35);background:linear-gradient(180deg, rgba(70,110,255,.18), rgba(70,110,255,.08));color:#dbe6ff;cursor:pointer;font-weight:700;"
                  >Create email</button>
                  <button
                    type="button"
                    onclick="toggleDraftEditor(${Number(r.id)})"
                    style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#ffffff;cursor:pointer;font-weight:700;"
                  >Edit</button>
                  <button
                    type="button"
                    onclick="clearDraft(${Number(r.id)})"
                    style="padding:6px 10px;border-radius:8px;border:1px solid rgba(255,120,120,.30);background:rgba(120,20,20,.18);color:#ffd7d7;cursor:pointer;font-weight:700;"
                  >Clear</button>
                </div>
              </td>
            </tr>
            <tr>
              <td colspan="8" style="background:#f8fbff;border-top:0;">
                <div style="padding:14px 6px 6px;">
                  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;margin-bottom:8px;">Saved draft</div>
                  <div style="font-weight:800;color:#0f172a;margin-bottom:8px;">${esc(r.draft_subject || "") || "No draft yet"}</div>
                  <div style="white-space:pre-wrap;line-height:1.55;color:#334155;margin-bottom:12px;">${esc(r.draft_body || "")}</div>

                  <div id="draft-editor-${Number(r.id)}" style="display:none;margin-top:10px;padding:14px;border-radius:14px;border:1px solid rgba(148,163,184,.22);background:linear-gradient(180deg,#ffffff 0%,#f8fbff 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.8);">
                    <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;margin-bottom:8px;">Edit draft</div>
                    <input
                      id="draft-subject-${Number(r.id)}"
                      type="text"
                      value="${esc(r.draft_subject || "")}"
                      style="width:100%;margin-bottom:10px;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0b1220;color:#fff;"
                    />
                    <textarea
                      id="draft-body-${Number(r.id)}"
                      style="width:100%;min-height:260px;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#0b1220;color:#fff;line-height:1.45;"
                    >${esc(r.draft_body || "")}</textarea>
                    <div style="display:flex;gap:8px;margin-top:10px;">
                      <button
                        type="button"
                        onclick="saveDraft(${Number(r.id)})"
                        style="padding:8px 12px;border-radius:8px;border:1px solid rgba(125,162,255,.35);background:linear-gradient(180deg, rgba(70,110,255,.18), rgba(70,110,255,.08));color:#dbe6ff;cursor:pointer;font-weight:700;"
                      >Save draft</button>
                      <button
                        type="button"
                        onclick="toggleDraftEditor(${Number(r.id)})"
                        style="padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#ffffff;cursor:pointer;font-weight:700;"
                      >Close</button>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          `).join("") || '<tr><td colspan="8">No queued openers yet.</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
  `;

  return reply.type("text/html").send(layout("Queued Openers", body));
});

fastify.listen({ port: PORT, host: "0.0.0.0" }).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

/* =========================
fastify.get("/debug/outlook/me", async (req, reply) => {
  if (!requireAuth(req, reply)) return;
  const data = await outlookGraphGetJson("/v1.0/me");
  return reply.send(data);
});

   MICROSOFT OUTLOOK OAUTH
   ========================= */

const https_ms_oauth = require("https");

function msGetToken() {
  return db.prepare("SELECT * FROM oauth_tokens WHERE provider='microsoft'").get();
}

function msSaveToken(t) {
  db.prepare(`
    INSERT OR REPLACE INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
    VALUES ('microsoft', @access_token, @refresh_token, @expires_at)
  `).run(t);
}

fastify.get("/ms/connect", async (req, reply) => {
  if (!requireAuth(req, reply)) return;

  const tenant = process.env.MS_TENANT_ID || "";
  const client = process.env.MS_CLIENT_ID || "";
  const redirect = process.env.MS_REDIRECT_URI || "";

  if (!tenant || !client || !redirect) {
    return reply.code(500).send("Missing MS_TENANT_ID or MS_CLIENT_ID or MS_REDIRECT_URI");
  }

  const url =
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize` +
    `?client_id=${encodeURIComponent(client)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&response_mode=query` +
    `&scope=${encodeURIComponent("offline_access https://graph.microsoft.com/Mail.ReadWrite")}`;

  return reply.redirect(url);
});

fastify.get("/ms/callback", async (req, reply) => {
  const code = String((req.query && req.query.code) || "");
  if (!code) return reply.code(400).send("Missing code");

  const tenant = process.env.MS_TENANT_ID || "";
  const client = process.env.MS_CLIENT_ID || "";
  const secret = process.env.MS_CLIENT_SECRET || "";
  const redirect = process.env.MS_REDIRECT_URI || "";

  if (!tenant || !client || !secret || !redirect) {
    return reply.code(500).send("Missing MS_TENANT_ID or MS_CLIENT_ID or MS_CLIENT_SECRET or MS_REDIRECT_URI");
  }

  const postData =
    `client_id=${encodeURIComponent(client)}` +
    `&scope=${encodeURIComponent("https://graph.microsoft.com/Mail.ReadWrite offline_access")}` +
    `&code=${encodeURIComponent(code)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}` +
    `&grant_type=authorization_code` +
    `&client_secret=${encodeURIComponent(secret)}`;

  const token = await new Promise((resolve, reject) => {
    const req2 = https_ms_oauth.request({
      method: "POST",
      hostname: "login.microsoftonline.com",
      path: `/${tenant}/oauth2/v2.0/token`,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error("MS_TOKEN_ERROR " + res.statusCode + " " + data));
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("MS_TOKEN_PARSE_ERROR " + data.slice(0, 300))); }
      });
    });
    req2.on("error", reject);
    req2.setTimeout(30000, () => req2.destroy(new Error("MS_TOKEN_TIMEOUT")));
    req2.write(postData);
    req2.end();
  });

  msSaveToken({
    access_token: String(token.access_token || ""),
    refresh_token: String(token.refresh_token || ""),
    expires_at: Math.floor(Date.now() / 1000) + Number(token.expires_in || 0),
  });

  return reply.type("text/html").send("Microsoft connected successfully. You can close this tab.");
});

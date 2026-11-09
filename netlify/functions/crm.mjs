// Cold Call HQ backend — talks to both GHL sub-accounts and keeps today's call log.
// Env vars (Netlify → Site configuration → Environment variables):
//   DASHBOARD_PASSWORD      password you type on /dashboard
//   GHL_ARLO_TOKEN          Private Integration Token from the Arlo GHL sub-account
//   GHL_ARLO_LOCATION       Arlo location ID (from the GHL URL: /v2/location/<THIS>/...)
//   GHL_CF_TOKEN            Private Integration Token from the Hula Creative sub-account
//   GHL_CF_LOCATION         Hula Creative location ID
//   COLD_CALL_TAG           optional, defaults to "cold-call"
//   STRIPE_KEY              Stripe restricted key (read-only: Charges + Refunds) — rk_live_...
//   GHL_ARLO_TAGS / GHL_CF_TAGS  optional JSON to match YOUR workflow trigger tags, e.g.
//                           {"booked":"meeting booked","int":"interested","ni":"not interested","na":"no answer"}
//   TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, TWILIO_APP_SID   for in-browser calling
//   REVENUE_GOAL            optional monthly goal in dollars, defaults to 10000
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const GHL = "https://services.leadconnectorhq.com";
const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : process.env[k]);
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const OUTCOME_TAG = { na: "cc-no-answer", vm: "cc-no-answer", int: "cc-interested", talked: "cc-interested", booked: "cc-booked", ni: "cc-not-interested" };
const OUTCOME_TXT = { na: "No answer / voicemail", vm: "Voicemail", int: "Interested, no meeting yet", talked: "Interested", booked: "Meeting booked", ni: "Not interested" };

// Tag added in GHL for each button. Each account can use its own names (see GHL_*_TAGS).
function tagFor(brand, outcome) {
  let custom = {};
  try { custom = JSON.parse(env(brand === "cf" ? "GHL_CF_TAGS" : "GHL_ARLO_TAGS") || "{}"); } catch (e) {}
  const key = outcome === "vm" ? "na" : outcome === "talked" ? "int" : outcome;
  // ContractFlow (Hula) workflows trigger on these exact tags
  const CF_TAGS = { booked: "call-booked", int: "call-interested", ni: "call-not-interested", na: "call-no-answer" };
  return custom[key] || (brand === "cf" ? CF_TAGS[key] : OUTCOME_TAG[key]);
}
function account(brand) {
  const key = brand === "cf" ? "CF" : "ARLO";
  return { token: env(`GHL_${key}_TOKEN`), location: env(`GHL_${key}_LOCATION`) };
}
function todayCT() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date());
}
async function ghl(brand, path, init = {}) {
  const { token } = account(brand);
  const r = await fetch(GHL + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`GHL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
function shape(c) {
  const name = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || c.companyName || c.phone || "Unnamed";
  return { id: c.id, name, company: c.companyName && c.companyName !== name ? c.companyName : "", phone: c.phone || "", email: c.email || "", tags: c.tags || [] };
}

async function getLeads(brand, q) {
  const { location } = account(brand);
  if (!account(brand).token || !location) throw new Error(`Missing ${brand === "cf" ? "GHL_CF" : "GHL_ARLO"}_TOKEN or _LOCATION in Netlify`);
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tag = norm(env("COLD_CALL_TAG") || "cold-call"); // matches cold-call, cold call, Cold_Call, coldcall
  const hasTag = (c) => (c.tags || []).some((t) => norm(t) === tag);
  const all = [];
  let lastErr = null;
  // 1) Search endpoint (no server-side filter; we filter by tag ourselves — most reliable)
  try {
    for (let page = 1; page <= 10; page++) {
      const body = { locationId: location, pageLimit: 100, page };
      if (q) body.query = q;
      const r = await ghl(brand, "/contacts/search", { method: "POST", body: JSON.stringify(body) });
      const list = r.contacts || [];
      all.push(...list);
      if (list.length < 100) break;
    }
  } catch (e) { lastErr = e; }
  // 2) Fallback: older list endpoint
  if (!all.length) {
    try {
      const qs = new URLSearchParams({ locationId: location, limit: "100" });
      if (q) qs.set("query", q);
      all.push(...((await ghl(brand, "/contacts/?" + qs)).contacts || []));
    } catch (e) { lastErr = lastErr || e; }
  }
  if (!all.length && lastErr) throw lastErr;
  return (q ? all : all.filter(hasTag)).map(shape);
}

// Sum of successful charges (minus refunds) per month, last 6 months, Chicago time.
async function stripeRevenue() {
  const key = env("STRIPE_KEY");
  if (!key) return { connected: false, byMonth: {} };
  const now = new Date();
  const start = Math.floor(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime() / 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit" });
  const byMonth = {};
  let after = null;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ limit: "100", "created[gte]": String(start) });
    if (after) qs.set("starting_after", after);
    const r = await fetch("https://api.stripe.com/v1/charges?" + qs, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`Stripe ${r.status}`);
    const data = await r.json();
    for (const c of data.data) {
      if (c.status !== "succeeded" || !c.paid) continue;
      const net = (c.amount_captured ?? c.amount) - (c.amount_refunded || 0);
      const m = fmt.format(new Date(c.created * 1000));
      byMonth[m] = (byMonth[m] || 0) + net / 100;
    }
    if (!data.has_more || !data.data.length) break;
    after = data.data[data.data.length - 1].id;
  }
  return { connected: true, byMonth };
}

// Twilio Voice access token (JWT) — lets the browser place calls through your TwiML App.
function b64url(x) { return Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url"); }
function twilioToken() {
  const sid = env("TWILIO_ACCOUNT_SID"), key = env("TWILIO_API_KEY"), secret = env("TWILIO_API_SECRET"), app = env("TWILIO_APP_SID");
  if (!sid || !key || !secret || !app) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = { jti: `${key}-${now}`, iss: key, sub: sid, iat: now, nbf: now, exp: now + 3600,
    grants: { identity: "dashboard", voice: { incoming: { allow: false }, outgoing: { application_sid: app } } } };
  const unsigned = b64url(header) + "." + b64url(payload);
  const sig = crypto.createHmac("sha256", secret).update(unsigned).digest("base64url");
  return unsigned + "." + sig;
}
const CONV = { Version: "2021-04-15" };

export default async (req) => {
  if (!env("DASHBOARD_PASSWORD") || req.headers.get("x-dash-key") !== env("DASHBOARD_PASSWORD")) return json({ error: "auth" }, 401);

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const store = getStore("cold-calls");
  const day = todayCT();
  const readLog = async () => (await store.get(day, { type: "json" })) || [];

  try {
    if (action === "today") {
      const settings = (await store.get("settings", { type: "json" })) || null;
      return json({ log: await readLog(), settings, locations: { arlo: account("arlo").location, cf: account("cf").location } });
    }
    if (action === "token") {
      const token = twilioToken();
      return json(token ? { token } : { token: null, error: "Twilio not set up yet" });
    }
    if (action === "convos") {
      const b = url.searchParams.get("brand") === "cf" ? "cf" : "arlo";
      const qs = new URLSearchParams({ locationId: account(b).location, limit: "40", sort: "desc", sortBy: "last_message_date" });
      const r = await ghl(b, "/conversations/search?" + qs, { headers: CONV });
      return json({ conversations: (r.conversations || []).map((c) => ({
        id: c.id, contactId: c.contactId, name: c.fullName || c.contactName || c.phone || "Unknown", phone: c.phone || "",
        last: c.lastMessageBody || "", lastType: c.lastMessageType || "", at: c.lastMessageDate || c.dateUpdated, unread: c.unreadCount || 0,
      })) });
    }
    if (action === "messages") {
      const b = url.searchParams.get("brand") === "cf" ? "cf" : "arlo";
      const id = url.searchParams.get("id");
      const r = await ghl(b, `/conversations/${encodeURIComponent(id)}/messages?limit=60`, { headers: CONV });
      const list = (r.messages && r.messages.messages) || r.messages || [];
      return json({ messages: list.map((m) => ({
        id: m.id, dir: m.direction, body: m.body || "", type: m.messageType || m.type, at: m.dateAdded,
        status: m.status || (m.meta && m.meta.call && m.meta.call.status) || "", duration: (m.meta && m.meta.call && m.meta.call.duration) || 0,
      })).reverse() });
    }
    if (action === "sms" && req.method === "POST") {
      const { brand, contactId, message } = await req.json();
      const b = brand === "cf" ? "cf" : "arlo";
      const r = await ghl(b, "/conversations/messages", { method: "POST", headers: CONV, body: JSON.stringify({ type: "SMS", contactId, message }) });
      return json({ ok: true, id: r.messageId || r.id });
    }
    if (action === "revenue") {
      const rev = await stripeRevenue();
      return json({ ...rev, goal: Number(env("REVENUE_GOAL")) || 10000 });
    }
    if (action === "leads") {
      const brand = url.searchParams.get("brand") === "cf" ? "cf" : "arlo";
      return json({ leads: await getLeads(brand, url.searchParams.get("q") || ""), locationId: account(brand).location });
    }
    if (action === "log" && req.method === "POST") {
      const { entry } = await req.json();
      const log = await readLog();
      if (!log.some((e) => e.id === entry.id)) log.push(entry);
      await store.setJSON(day, log);
      // write the outcome back to the contact in GHL (best effort)
      if (entry.contactId) {
        const b = entry.brand === "cf" ? "cf" : "arlo";
        const when = new Date(entry.t).toLocaleString("en-US", { timeZone: "America/Chicago" });
        // 1) save email first so any email/SMS workflow has it  2) add the tag that triggers your workflow  3) note
        if (entry.email) await ghl(b, `/contacts/${entry.contactId}`, { method: "PUT", body: JSON.stringify({ email: entry.email }) }).catch(() => {});
        const tag = tagFor(b, entry.outcome);
        await Promise.allSettled([
          tag && ghl(b, `/contacts/${entry.contactId}/tags`, { method: "POST", body: JSON.stringify({ tags: [tag] }) }),
          ghl(b, `/contacts/${entry.contactId}/notes`, { method: "POST", body: JSON.stringify({ body: `Cold call: ${OUTCOME_TXT[entry.outcome] || entry.outcome} (${when})${entry.email ? " · email " + entry.email : ""}${entry.note ? "\n\n" + entry.note : ""}` }) }),
        ]);
      }
      return json({ log });
    }
    if (action === "settings" && req.method === "POST") {
      const { settings } = await req.json();
      await store.setJSON("settings", settings);
      return json({ ok: true });
    }
    if (action === "create" && req.method === "POST") {
      const { brand, name, phone, email, company } = await req.json();
      const b = brand === "cf" ? "cf" : "arlo";
      const [firstName, ...rest] = String(name || "").trim().split(/\s+/);
      const body = { locationId: account(b).location, firstName, lastName: rest.join(" "), phone, email: email || undefined, companyName: company || undefined, tags: [env("COLD_CALL_TAG") || "cold-call"] };
      const r = await ghl(b, "/contacts/upsert", { method: "POST", body: JSON.stringify(body) });
      return json({ lead: shape(r.contact || r) });
    }
    if (action === "undo" && req.method === "POST") {
      const { id } = await req.json();
      const log = (await readLog()).filter((e) => e.id !== id);
      await store.setJSON(day, log);
      return json({ log });
    }
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
};

export const config = { path: "/api/crm" };

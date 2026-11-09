// Twilio calls this when you press call on the dashboard. It tells Twilio who to dial
// and which of YOUR GHL numbers to show as caller ID.
// Env: TWILIO_AUTH_TOKEN, TWILIO_CALLERID_ARLO, TWILIO_CALLERID_CF  (verified caller IDs, +1XXXXXXXXXX)
import crypto from "node:crypto";

const env = (k) => (typeof Netlify !== "undefined" ? Netlify.env.get(k) : process.env[k]);
const xml = (body, status = 200) => new Response(body, { status, headers: { "content-type": "text/xml" } });
const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));

function validSignature(url, params, signature, token) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", token).update(Buffer.from(data, "utf-8")).digest("base64");
  if (!signature) return false;
  const a = Buffer.from(expected), b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export default async (req) => {
  const form = new URLSearchParams(await req.text());
  const params = Object.fromEntries(form);
  const base = env("URL") || new URL(req.url).origin; // Netlify sets URL to your site's main URL
  const url = base.replace(/\/$/, "") + "/api/voice";
  if (!validSignature(url, params, req.headers.get("x-twilio-signature"), env("TWILIO_AUTH_TOKEN") || "")) {
    return xml("<Response><Reject/></Response>", 403);
  }
  const to = String(params.To || "").replace(/[^\d+]/g, "");
  if (!/^\+?1?\d{10}$/.test(to)) return xml("<Response><Say>That number looks wrong.</Say></Response>");
  const e164 = to.startsWith("+") ? to : "+1" + to.replace(/^1(?=\d{10}$)/, "");
  const rawCaller = String((params.brand === "cf" ? env("TWILIO_CALLERID_CF") : env("TWILIO_CALLERID_ARLO")) || "").replace(/[^\d]/g, "");
  const callerId = "+" + (rawCaller.length === 10 ? "1" + rawCaller : rawCaller);
  return xml(`<Response><Dial callerId="${esc(callerId)}" answerOnBridge="true" timeout="30"><Number>${esc(e164)}</Number></Dial></Response>`);
};

export const config = { path: "/api/voice" };

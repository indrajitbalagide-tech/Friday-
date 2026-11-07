"use strict";
/**
 * Vaani Remote Server - zero dependencies (Node 18+).
 *
 *   Browser (website)  <--HTTPS-->  ye server  <--HTTPS (phone khud connect karta hai)-->  Vaani phone app
 *
 * Phone is server se bahar ki taraf (outbound) juda rehta hai, isliye router/port-forwarding ki zaroorat nahi.
 * ENV: ADMIN_PASSWORD (website login, 8+ akshar), DEVICE_TOKEN (phone ka secret, 16+ akshar), PORT.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || "";
if (ADMIN_PASSWORD.length < 8 || DEVICE_TOKEN.length < 16) {
  console.error("ADMIN_PASSWORD (kam se kam 8 akshar) aur DEVICE_TOKEN (kam se kam 16 akshar) env mein set karo.");
  process.exit(1);
}
const SECRET = crypto.createHash("sha256").update("vaani|" + ADMIN_PASSWORD + "|" + DEVICE_TOKEN).digest();
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const SESSION_MS = 30 * 24 * 3600 * 1000;
const LONG_POLL_MS = 25000;
const ONLINE_MS = 45000;
const MAX_BODY = 20000;
const MAX_TEXT = 2000;
const HISTORY_MAX = 300;

// ---------- helpers ----------
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function makeSession() {
  const exp = String(Date.now() + SESSION_MS);
  const sig = crypto.createHmac("sha256", SECRET).update(exp).digest("base64url");
  return b64u(exp) + "." + sig;
}
function validSession(tok) {
  if (!tok || tok.indexOf(".") < 0) return false;
  const [e, sig] = tok.split(".");
  let exp;
  try { exp = Buffer.from(e, "base64url").toString(); } catch { return false; }
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac("sha256", SECRET).update(exp).digest("base64url");
  return safeEq(sig, want);
}
function cookieOf(req, name) {
  const h = req.headers.cookie || "";
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}
const isWeb = (req) => validSession(cookieOf(req, "vs"));
const isDevice = (req) => {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") && safeEq(h.slice(7), DEVICE_TOKEN);
};

const SEC_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};
function send(res, code, body, extra) {
  const isObj = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(code, Object.assign({ "Content-Type": isObj ? "application/json; charset=utf-8" : "text/html; charset=utf-8" }, SEC_HEADERS, extra || {}));
  res.end(isObj ? JSON.stringify(body) : body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers["content-type"] || "")) return reject(new Error("json chahiye"));
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error("bada")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || "{}")); } catch { reject(new Error("galat json")); } });
    req.on("error", reject);
  });
}

// ---------- state (memory mein; restart par saaf) ----------
let seq = 0;
const history = [];
const queue = [];
let lastSeen = 0;
const webWaiters = new Set();
let deviceWaiter = null;
const online = () => Date.now() - lastSeen < ONLINE_MS;

function addMsg(role, text) {
  seq++;
  history.push({ n: seq, role, text: String(text).slice(0, 8000), ts: Date.now() });
  if (history.length > HISTORY_MAX) history.shift();
  for (const w of [...webWaiters]) {
    const items = history.filter((m) => m.n > w.since);
    if (items.length) { clearTimeout(w.timer); webWaiters.delete(w); send(w.res, 200, { items, seq, online: online() }); }
  }
}
function deliverToDevice() {
  if (deviceWaiter && queue.length) {
    const w = deviceWaiter; deviceWaiter = null; clearTimeout(w.timer);
    send(w.res, 200, queue.shift());
  }
}

// ---------- login rate-limit ----------
const fails = new Map();
function clientIp(req) { return ((req.headers["x-forwarded-for"] || "").split(",")[0] || req.socket.remoteAddress || "?").trim(); }
function blocked(ip) { const f = fails.get(ip); return f && f.n >= 5 && Date.now() - f.t < 15 * 60 * 1000; }
function noteFail(ip) { const f = fails.get(ip); if (!f || Date.now() - f.t > 15 * 60 * 1000) fails.set(ip, { n: 1, t: Date.now() }); else { f.n++; f.t = Date.now(); } }
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (now - v.t > 15 * 60 * 1000) fails.delete(k); }, 600000).unref();

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  try {
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, INDEX);
    if (req.method === "GET" && p === "/healthz") return send(res, 200, { ok: true });

    // ----- website API -----
    if (p === "/api/login" && req.method === "POST") {
      const ip = clientIp(req);
      if (blocked(ip)) return send(res, 429, { error: "Bahut koshish. 15 minute baad try karo." });
      const b = await readJson(req);
      if (typeof b.password !== "string" || !safeEq(b.password, ADMIN_PASSWORD)) { noteFail(ip); return send(res, 401, { error: "Password galat." }); }
      fails.delete(ip);
      const secure = (req.headers["x-forwarded-proto"] || "") === "https" ? "; Secure" : "";
      return send(res, 200, { ok: true }, { "Set-Cookie": `vs=${makeSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}` });
    }
    if (p === "/api/logout" && req.method === "POST") {
      return send(res, 200, { ok: true }, { "Set-Cookie": "vs=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
    }
    if (p.startsWith("/api/")) {
      if (!isWeb(req)) return send(res, 401, { error: "login chahiye" });
      if (p === "/api/me" && req.method === "GET") return send(res, 200, { ok: true, online: online() });
      if (p === "/api/send" && req.method === "POST") {
        const b = await readJson(req);
        const text = String(b.text || "").trim().slice(0, MAX_TEXT);
        if (!text) return send(res, 400, { error: "khali" });
        addMsg("user", text);
        queue.push({ id: crypto.randomBytes(6).toString("hex"), text });
        if (queue.length > 20) queue.shift();
        if (!online()) addMsg("sys", "Phone abhi offline hai. Online (aur Vaani chalu) hote hi ye kaam chalega.");
        deliverToDevice();
        return send(res, 200, { ok: true });
      }
      if (p === "/api/poll" && req.method === "GET") {
        const since = Number(url.searchParams.get("since")) || 0;
        const items = history.filter((m) => m.n > since);
        if (items.length || url.searchParams.get("init") === "1") return send(res, 200, { items, seq, online: online() });
        const w = { res, since };
        w.timer = setTimeout(() => { webWaiters.delete(w); send(res, 200, { items: [], seq, online: online() }); }, LONG_POLL_MS);
        webWaiters.add(w);
        res.on("close", () => { clearTimeout(w.timer); webWaiters.delete(w); });
        return;
      }
      if (p === "/api/clear" && req.method === "POST") { history.length = 0; queue.length = 0; return send(res, 200, { ok: true, seq }); }
      return send(res, 404, { error: "nahi mila" });
    }

    // ----- phone API -----
    if (p.startsWith("/device/")) {
      if (!isDevice(req)) return send(res, 401, { error: "token galat" });
      lastSeen = Date.now();
      if (p === "/device/next" && req.method === "GET") {
        if (queue.length) return send(res, 200, queue.shift());
        if (deviceWaiter) { const o = deviceWaiter; deviceWaiter = null; clearTimeout(o.timer); send(o.res, 200, {}); }
        const w = { res };
        w.timer = setTimeout(() => { if (deviceWaiter === w) deviceWaiter = null; lastSeen = Date.now(); send(res, 200, {}); }, LONG_POLL_MS);
        deviceWaiter = w;
        res.on("close", () => { clearTimeout(w.timer); if (deviceWaiter === w) deviceWaiter = null; });
        return;
      }
      if (p === "/device/reply" && req.method === "POST") {
        const b = await readJson(req);
        addMsg("vaani", String(b.text || "Ho gaya."));
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: "nahi mila" });
    }
    send(res, 404, { error: "nahi mila" });
  } catch (e) {
    send(res, 400, { error: String(e.message || e).slice(0, 80) });
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.listen(PORT, () => console.log("Vaani remote server chal raha hai, port " + PORT));

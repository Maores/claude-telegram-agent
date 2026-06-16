/**
 * net.ts — the hardened outbound-fetch layer for monitors (feature E2).
 *
 * Monitors pull UNTRUSTED external content into the agent, so every fetch runs
 * a barrier stack: an SSRF/destination guard (https-only, no private/loopback/
 * link-local/metadata addresses, re-checked on every redirect hop), fetch
 * hardening (timeout, size cap, content-type allowlist), and pure text/hash
 * helpers for change detection. The guard helpers are pure and table-tested;
 * the live fetch in safeFetch() is the only network-touching part.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

// ---------- SSRF / destination guard (pure) ----------

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

function inRange(ip: number, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const baseInt = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

// IPv4 ranges that must never be fetched: loopback, RFC1918 private, CGNAT,
// link-local (incl. the 169.254.169.254 cloud-metadata endpoint), multicast,
// reserved, broadcast.
const V4_BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
  "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16",
  "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
];

/** True if `ip` (v4 or v6 literal) is a private/loopback/link-local/reserved address. */
export function isBlockedIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i); // IPv4-mapped IPv6
  if (mapped) return isBlockedIp(mapped[1]);
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return V4_BLOCKED.some((c) => inRange(v4, c));
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;                 // loopback / unspecified
  if (/^fe[89ab]/.test(low)) return true;                          // fe80::/10 link-local
  if (/^f[cd]/.test(low)) return true;                             // fc00::/7 unique-local
  return false;
}

export type UrlCheck = { ok: true; host: string } | { ok: false; reason: string };

/** Pure URL-shape + literal-IP check. DNS resolution happens later in safeFetch. */
export function parseAndCheckUrl(raw: string): UrlCheck {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "invalid url" }; }
  if (u.protocol !== "https:") return { ok: false, reason: "only https is allowed" };
  if (u.port && u.port !== "443") return { ok: false, reason: "only port 443 is allowed" };
  const host = u.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (ipv4ToInt(host) !== null || host.includes(":")) {
    if (isBlockedIp(host)) return { ok: false, reason: "blocked ip address" };
  }
  if (/^(localhost|.*\.local|metadata\.google\.internal)$/i.test(u.hostname)) {
    return { ok: false, reason: "blocked host" };
  }
  return { ok: true, host: u.hostname };
}

// ---------- text extraction + hashing (pure) ----------

/** Strip scripts/styles/tags to rough plain text (enough for change detection). */
export function extractText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

/** Collapse runs of whitespace and trim. */
export function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Stable content hash for diffing. */
export function hashContent(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------- hardened fetch (network) ----------

const MAX_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const OK_CONTENT_TYPES = ["text/html", "application/json", "text/plain"];
const USER_AGENT = "claude-telegram-agent-monitor/1.0";

async function resolveSafe(host: string): Promise<{ ok: boolean; reason?: string }> {
  // A literal IP needs no DNS — parseAndCheckUrl already vetted literals.
  if (ipv4ToInt(host) !== null || host.includes(":")) return { ok: true };
  try {
    const recs = await lookup(host, { all: true });
    if (!recs.length) return { ok: false, reason: "dns: no records" };
    for (const r of recs) if (isBlockedIp(r.address)) return { ok: false, reason: "resolves to a blocked ip" };
    return { ok: true };
  } catch {
    return { ok: false, reason: "dns lookup failed" };
  }
}

export type FetchResult =
  | { ok: true; status: number; contentType: string; text: string }
  | { ok: false; error: string };

/**
 * Fetch `url` through the full barrier stack: https-only + destination guard
 * (re-checked on every redirect), 10s timeout, 1.5 MB cap, content-type
 * allowlist, no cookies/auth. Returns the decoded body text or an error reason.
 */
export async function safeFetch(url: string): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const chk = parseAndCheckUrl(current);
    if (!chk.ok) return { ok: false, error: chk.reason };
    const dnsChk = await resolveSafe(chk.host);
    if (!dnsChk.ok) return { ok: false, error: dnsChk.reason! };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(current, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: { "user-agent": USER_AGENT, accept: OK_CONTENT_TYPES.join(",") },
      });
    } catch (e) {
      clearTimeout(timer);
      return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    clearTimeout(timer);

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("location");
      if (!loc) return { ok: false, error: "redirect without location" };
      current = new URL(loc, current).href; // re-checked on the next loop iteration
      continue;
    }

    const ct = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!OK_CONTENT_TYPES.includes(ct)) return { ok: false, error: `content-type not allowed: ${ct || "(none)"}` };
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { ok: false, error: "response too large" };
    return { ok: true, status: resp.status, contentType: ct, text: new TextDecoder().decode(buf) };
  }
  return { ok: false, error: "too many redirects" };
}

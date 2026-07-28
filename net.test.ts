import { test, expect } from "bun:test";
import {
  isBlockedIp, parseAndCheckUrl, extractText, normalize, hashContent, safeFetch,
  charsetFrom, decodeBody,
} from "./net";

test("isBlockedIp blocks loopback/private/link-local/metadata/ula", () => {
  for (const ip of [
    "127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "169.254.0.1", "0.0.0.0", "100.64.0.1",
    "::1", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1",
  ]) {
    expect(isBlockedIp(ip)).toBe(true);
  }
});

test("isBlockedIp allows public addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "140.82.121.4", "2606:4700:4700::1111"]) {
    expect(isBlockedIp(ip)).toBe(false);
  }
});

test("parseAndCheckUrl rejects non-https, bad ports, raw blocked IPs, special hosts", () => {
  expect(parseAndCheckUrl("http://example.com").ok).toBe(false);
  expect(parseAndCheckUrl("https://example.com:8080").ok).toBe(false);
  expect(parseAndCheckUrl("https://169.254.169.254/latest/meta-data").ok).toBe(false);
  expect(parseAndCheckUrl("https://127.0.0.1/").ok).toBe(false);
  expect(parseAndCheckUrl("https://localhost/").ok).toBe(false);
  expect(parseAndCheckUrl("https://metadata.google.internal/").ok).toBe(false);
  expect(parseAndCheckUrl("ftp://example.com").ok).toBe(false);
  expect(parseAndCheckUrl("not a url").ok).toBe(false);
});

test("parseAndCheckUrl accepts a normal https url", () => {
  const r = parseAndCheckUrl("https://example.com/path?q=1");
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.host).toBe("example.com");
});

test("extractText strips tags, scripts, styles", () => {
  const html =
    "<html><head><style>x{color:red}</style></head><body>Hi <b>there</b><script>bad()</script></body></html>";
  const t = extractText(html);
  expect(t).toContain("Hi");
  expect(t).toContain("there");
  expect(t).not.toContain("bad()");
  expect(t).not.toContain("color:red");
});

test("normalize collapses whitespace; hashContent is stable + sensitive", () => {
  expect(normalize("a   b\n\n c")).toBe("a b c");
  expect(hashContent("abc")).toBe(hashContent("abc"));
  expect(hashContent("abc")).not.toBe(hashContent("abd"));
});

test("safeFetch refuses a blocked destination before any network call", async () => {
  const r = await safeFetch("https://169.254.169.254/latest/meta-data/");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(/blocked|https|port|ip/i);
});

// --- charset-aware decoding ---------------------------------------------------
// Hebrew sites still serve windows-1255; decoding those as UTF-8 produced
// replacement junk, which broke monitor keywords and summaries silently.

// "שלום" in windows-1255 (ש=0xF9 ל=0xEC ו=0xE5 ם=0xED).
const SHALOM_1255 = new Uint8Array([0xf9, 0xec, 0xe5, 0xed]);

test("charsetFrom reads the charset parameter case-insensitively", () => {
  // seret.co.il really sends the capital-C spelling.
  expect(charsetFrom("text/html; Charset=windows-1255")).toBe("windows-1255");
  expect(charsetFrom("text/html;charset=UTF-8")).toBe("utf-8");
  expect(charsetFrom('text/html; charset="windows-1255"')).toBe("windows-1255");
});

test("charsetFrom defaults to utf-8 when the header says nothing", () => {
  expect(charsetFrom("text/html")).toBe("utf-8");
  expect(charsetFrom("")).toBe("utf-8");
});

test("decodeBody decodes windows-1255 Hebrew correctly", () => {
  expect(decodeBody(SHALOM_1255, "text/html; Charset=windows-1255")).toBe("שלום");
});

test("decodeBody without a charset treats bytes as utf-8 (the old behavior)", () => {
  expect(decodeBody(new TextEncoder().encode("שלום"), "text/html")).toBe("שלום");
  // the regression this fix targets: 1255 bytes read as utf-8 are unreadable
  expect(decodeBody(SHALOM_1255, "text/html")).not.toBe("שלום");
});

test("decodeBody falls back to utf-8 on a charset label it doesn't know", () => {
  expect(decodeBody(new TextEncoder().encode("hello"), "text/html; charset=x-not-a-charset")).toBe("hello");
});

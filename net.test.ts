import { test, expect } from "bun:test";
import {
  isBlockedIp, parseAndCheckUrl, extractText, normalize, hashContent, safeFetch,
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

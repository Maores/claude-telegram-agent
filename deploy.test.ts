/**
 * deploy.test.ts — the deploy must never claim success it did not achieve.
 *
 * 2026-08-10: two deploys printed "Deploy complete" while the poller kept running
 * the process it had started five days earlier. The code reached the disk, the
 * restart silently did not happen, and nothing said so. These tests drive
 * restart_and_verify against stub `systemctl`/`sudo` binaries, so the failure
 * mode is reproduced rather than described.
 */
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stub PATH whose `systemctl` reports the given start times and state.
 *  `before` is returned on the first ActiveEnterTimestampMonotonic query and
 *  `after` on every one after it, which is exactly what a real restart does. */
function stubDir(opts: { before: string; after: string; active?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-"));
  const marker = join(dir, "asked");
  const systemctl = `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "is-active" ]; then echo "${opts.active ?? "active"}"; exit 0; fi
done
if [ -e "${marker}" ]; then echo "${opts.after}"; else touch "${marker}"; echo "${opts.before}"; fi
exit 0
`;
  writeFileSync(join(dir, "systemctl"), systemctl);
  chmodSync(join(dir, "systemctl"), 0o755);
  // Keep the two-second settle from slowing the suite down.
  writeFileSync(join(dir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(join(dir, "sleep"), 0o755);
  return dir;
}

async function runVerify(dir: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(
    ["bash", "-c", `DEPLOY_SOURCE_ONLY=1 source ./deploy.sh; restart_and_verify telegram-agent`],
    {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
      // SUDO="" runs systemctl directly so the stub is reached: Windows ships a
      // real sudo.exe that would otherwise shadow any stub of that name.
      env: { ...process.env, PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`, SUDO: "" },
    },
  );
  const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
  return { code: await proc.exited, out };
}

test("a restart that really happened is reported as verified", async () => {
  const { code, out } = await runVerify(stubDir({ before: "1000000", after: "9500000" }));
  expect(code).toBe(0);
  expect(out).toContain("restart verified");
});

test("an unchanged start time fails the deploy loudly (the 2026-08-10 silent failure)", async () => {
  const { code, out } = await runVerify(stubDir({ before: "1000000", after: "1000000" }));
  expect(code).not.toBe(0);
  expect(out).toContain("DEPLOY FAILED");
  // The message has to say what is actually true: new code on disk, old process serving.
  expect(out).toContain("OLD process is still serving");
});

test("a service that comes back not-active fails the deploy", async () => {
  const { code, out } = await runVerify(stubDir({ before: "1000000", after: "9500000", active: "failed" }));
  expect(code).not.toBe(0);
  expect(out).toContain("DEPLOY FAILED");
  expect(out).toContain("failed");
});

test("an empty or zero start time is treated as failure, not as success", async () => {
  const empty = await runVerify(stubDir({ before: "1000000", after: "" }));
  expect(empty.code).not.toBe(0);
  const zero = await runVerify(stubDir({ before: "0", after: "0" }));
  expect(zero.code).not.toBe(0);
});

test("deploy.sh verifies the restart rather than trusting it", async () => {
  const src = await Bun.file(join(import.meta.dir, "deploy.sh")).text();
  // A bare `systemctl restart` with nothing checking it is the bug itself.
  expect(src).toContain("restart_and_verify telegram-agent");
  // Monotonic, not wall clock: the incident came with wall-clock stamps days stale.
  expect(src).toContain("ActiveEnterTimestampMonotonic");
  expect(src).not.toContain("echo \"Deploy complete.\"");
});

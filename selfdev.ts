/**
 * selfdev.ts — helpers for the self-dev safety net (agenda #2).
 *
 * `filesToCapture` parses `git status --porcelain` output and returns the paths
 * of MODIFIED TRACKED files — exactly what a `git reset --hard` would destroy on
 * a deploy. It is the single source of truth for both the deploy-time capture
 * (`deploy.sh`) and the daily detector (`selfdev-check.ts`):
 *   - untracked files (`??`) survive a hard reset, so they're excluded;
 *   - gitignored files never appear in `--porcelain` output at all.
 * Pure, no IO — the callers do the git IO and feed the text in.
 */

/** Paths of modified/added/deleted/renamed TRACKED files from `git status --porcelain`. */
export function filesToCapture(porcelain: string): string[] {
  const out: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const xy = line.slice(0, 2);
    if (xy === "??" || xy === "!!") continue; // untracked / ignored — survive reset --hard
    let path = line.slice(3);
    // Renames/copies render as "old -> new"; the current file is the new path.
    const arrow = path.indexOf(" -> ");
    if (arrow !== -1) path = path.slice(arrow + 4);
    path = path.trim();
    // Porcelain double-quotes paths containing unusual characters.
    if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
      path = path.slice(1, -1);
    }
    if (path) out.push(path);
  }
  return out;
}

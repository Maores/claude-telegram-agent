#!/usr/bin/env bun
/**
 * selfdev-check.ts — print the modified tracked files (what a deploy's
 * `git reset --hard` would destroy), one per line. Prints nothing when clean.
 *
 * Used as an early-warning probe by the daily [AUTO] summary job: if this lists
 * any files, the bot adds a line to the summary telling Maor to run deploy.sh so
 * the edits are preserved on a droplet-autosave branch. Shares filesToCapture
 * with deploy.sh, so both agree on what counts as divergence.
 */
import { filesToCapture } from "./selfdev";

const proc = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: import.meta.dir });
const text = proc.success ? new TextDecoder().decode(proc.stdout) : "";
const files = filesToCapture(text);
if (files.length) console.log(files.join("\n"));

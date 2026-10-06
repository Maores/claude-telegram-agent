import { expect, test } from "bun:test";
import { checkCommand, checkFileWrite } from "./guard";

// The routine channel's store is written only by the poller and by the PC's sync over ssh (which
// never passes through the hook). An answer a turn wrote into it would be carried out on the PC.

test("a turn cannot write the routine channel's store, and can still read it", () => {
  for (const cmd of [
    "echo '{}' > ~/rchannel/store.json",
    "cat x.json >> /home/someone/rchannel/store.json",
    "cp /tmp/forged.json ~/rchannel/store.json",
    "mv /tmp/s ~/rchannel/store.json",
    "sed -i 's/a/b/' ~/rchannel/store.json",
    "tee ~/rchannel/store.json < /tmp/x",
    "rm ~/rchannel/store.json",
    // `>&WORD` writes to WORD unless WORD is exactly digits or `-`
    "mkdir -p 2 && echo '{}' >&2/../rchannel/store.json",
  ]) {
    expect(checkCommand(cmd)).toEqual({ verdict: "block", reason: "refused: the routine channel's store is written only by the poller and the PC's sync" });
  }
  for (const cmd of ["cat ~/rchannel/store.json", "jq .requests ~/rchannel/store.json", "grep -c q1 ~/rchannel/store.json"]) {
    expect(checkCommand(cmd).verdict).toBe("allow");
  }
});

test("a turn never runs the PC's sync, and propose stays allowed", () => {
  expect(checkCommand("echo '{}' | bun run rchannel.ts sync").verdict).toBe("block");
  expect(checkCommand("cd ~/claude-bot && ~/.bun/bin/bun run rchannel.ts   sync").verdict).toBe("block");
  expect(checkCommand("bun run rchannel.ts propose --request q1 --card 2 <<'EOF'\nתיאור חדש.\nEOF").verdict).toBe("allow");
  expect(checkCommand("grep -n sync rchannel.ts").verdict).toBe("allow");
});

test("the editing tools cannot write the store, its temporary file or its lock", () => {
  for (const p of ["/home/someone/rchannel/store.json", "~/rchannel/store.json.tmp", "rchannel/store.json.lock", "C:\\x\\rchannel\\store.json"]) {
    expect(checkFileWrite("Write", p).verdict).toBe("block");
  }
  for (const p of ["/home/someone/rchannel/store.json.corrupt-1", "/home/someone/claude-bot/rchannel.ts", "notes/store.json"]) {
    expect(checkFileWrite("Edit", p).verdict).toBe("allow");
  }
});

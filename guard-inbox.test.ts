import { expect, test } from "bun:test";
import { checkCommand, checkFileWrite, checkInboxAccess } from "./guard";

// The phone inbox is read and written only by the poller and by the PC's own key (which never
// passes through this hook). A turn may run `bun run inbox.ts status`, and nothing else.
const STORE = "refused: the phone inbox is read and written only by the poller and the PC's pull; a turn may run `bun run inbox.ts status`";
const PULL = "refused: inbox.ts list, ack, get, purge and gate are the PC's or the poller's; a turn never runs them";

test("a turn cannot read or write the inbox's store, files or folder", () => {
  for (const cmd of [
    "cat ~/inbox/items.json",
    "jq '.items | length' ~/inbox/items.json",
    "ls -la ~/inbox/files",
    "cd ~/inbox && cat items.json",
    "cd $HOME/inbox; rm items.json",
    "rm /home/someone/inbox/files/261005-a1b2.jpg",
    "echo '{}' > ~/inbox//items.json",
    "python3 -c \"import os; os.remove('inbox/items.json')\"",
    // relative to the turn's working folder, ~/claude-bot
    "cat ../inbox/*",
    "ls ../inbox",
    "grep -r http ../inbox",
    "cp -r ../inbox /tmp/x",
    "cd; cat inbox/*.json",
    "cat ~/\"inbox\"/items.json",
    // plain cd routes into the folder, and a quoted $HOME before the slash
    "cd .. && cd inbox && cat items.json",
    "cd; cd inbox; cat items.json",
    "pushd ~ && cd inbox && ls",
    "cd \"$HOME\"/inbox && cat items.json",
    "ls \"$HOME\"/inbox",
    // cd with its flags before the folder
    "cd; cd -P inbox && cat items.json",
    "cd -- inbox && cat items.json",
    "pushd -n inbox; ls",
  ]) {
    expect(checkCommand(cmd)).toEqual({ verdict: "block", reason: STORE });
  }
});

test("a turn never runs list, ack, get, purge or gate, however it is spelled", () => {
  for (const cmd of [
    "bun run inbox.ts list",
    "cd ~/claude-bot && ~/.bun/bin/bun run inbox.ts ack 261005-a1b2",
    "bun run inbox.ts   purge",
    "bun run inbox.ts \"ack\" 261005-a1b2",
    "bun inbox.ts 'purge'",
    "bun run inbox.ts get 261005-a1b2",
    "SSH_ORIGINAL_COMMAND=list bun run inbox.ts gate",
    // Bun strips a `--` before the script's arguments
    "bun run inbox.ts -- list",
    "bun inbox.ts -- ack 261005-a1b2",
    // only `status` is allowed, so a subcommand the guard cannot read is refused too
    "bun run inbox.ts '--' list",
    "bun run inbox.ts \"--\" ack 261005-a1b2",
    "bun run inbox.ts $(echo list)",
    "x=list; bun run inbox.ts $x",
    "echo list | xargs bun run inbox.ts",
    "bun run inbox.ts status; bun run inbox.ts list",
    "bun run inbox.ts statuslist",
    "bun run inbox.ts",
    // Bun runs a module named without its extension, and maps `.js` to `.ts`
    "bun run inbox list",
    "bun inbox ack 261005-a1b2",
    "bun run inbox purge",
    "~/.bun/bin/bun run inbox get 261005-a1b2",
    "bun inbox.js list",
    "bun /home/someone/claude-bot/inbox list",
    "bun run inbox.ts status && bun run inbox list",
  ]) {
    expect(checkCommand(cmd)).toEqual({ verdict: "block", reason: PULL });
  }
  expect(checkCommand("bun -e 'const m = await import(\"./inbox.ts\"); m.runInboxCli([\"ack\"], io)'").verdict).toBe("block");
});

test("status, the code, the tests and unrelated commands stay open", () => {
  for (const cmd of [
    "bun run inbox.ts status",
    "bun run inbox.ts status 2>&1 | jq .",
    "bun run inbox.ts status && echo ok",
    "bun run inbox.ts \"status\"",
    "bun run inbox status",
    "bun test inbox-cli.test.ts",
    "grep -n checkCommand guard.ts 2>&1 | head",
    "git add bun.lock inbox.ts",
    "grep -n purge inbox.ts",
    "grep -n \"inbox.ts list\" CLAUDE.md",
    "bun test inbox.test.ts",
    "bun test ./inbox-cli.test.ts",
    "git add inbox.ts inbox-cli.test.ts",
    "git diff inbox.ts",
    "node -p \"1\" && cat notes-about-inbox.txt",
    "grep -n inbox CLAUDE.md",
    "cd docs && ls",
    "echo inbox",
  ]) {
    expect(checkCommand(cmd).verdict).toBe("allow");
  }
});

// inbox.ts is also the PC key's forced command (`inbox.ts gate`), so a turn may not change it.
test("inbox.ts is protected like the guard; its tests stay editable", () => {
  for (const p of ["/home/someone/claude-bot/inbox.ts", "inbox.ts", "./inbox.ts"]) {
    expect(checkFileWrite("Edit", p).verdict).toBe("block");
    expect(checkFileWrite("Write", p).verdict).toBe("block");
  }
  for (const p of ["/home/someone/claude-bot/inbox-cli.test.ts", "inbox.test.ts", "myinbox.ts"]) {
    expect(checkFileWrite("Edit", p).verdict).toBe("allow");
  }
  for (const cmd of [
    "sed -i s/a/b/ inbox.ts",
    "echo x > inbox.ts",
    "cp /tmp/x.ts ~/claude-bot/inbox.ts",
    "echo x >& guard.ts",
  ]) {
    expect(checkCommand(cmd).verdict).toBe("block");
    expect(checkCommand(cmd).reason).toContain("inbox.ts");
  }
});

test("the file tools cannot touch anything under an inbox folder, nor search from above it", () => {
  for (const [tool, input] of [
    ["Read", { file_path: "/home/someone/inbox/items.json" }],
    ["Read", { file_path: "/home/someone/inbox/files/../items.json" }],
    ["Grep", { pattern: "x", path: "/home/someone/inbox" }],
    ["Grep", { pattern: "https", path: "/home/someone", glob: "**/*.json" }],
    ["Grep", { pattern: "x", path: "/home/someone/claude-bot", glob: "../inbox/**" }],
    ["Grep", { pattern: "x", path: "~" }],
    ["Grep", { pattern: "x", path: "/" }],
    ["Glob", { pattern: "**/inbox/**" }],
    ["Glob", { pattern: "*.json", path: "~/inbox/" }],
    ["Glob", { pattern: "**/*.jpg", path: "/home/someone" }],
    ["Write", { file_path: "~/inbox//items.json.tmp" }],
    ["Edit", { file_path: "C:\\x\\inbox\\items.json" }],
    ["NotebookEdit", { notebook_path: "/home/someone/inbox/x.ipynb" }],
    ["LS", { path: "/home/someone/inbox" }], // a legacy listing tool
  ] as const) {
    expect(checkInboxAccess(tool, input).verdict).toBe("block");
  }
  for (const [tool, input] of [
    ["Read", { file_path: "/home/someone/claude-bot/inbox.ts" }],
    ["Edit", { file_path: "/home/someone/claude-bot/inbox-cli.test.ts" }],
    ["Grep", { pattern: "inbox", path: "/home/someone/claude-bot" }],
    ["Grep", { pattern: "inbox" }],
    ["Glob", { pattern: "*.ts", path: "/home/someone/claude-bot" }],
    ["LS", { path: "/home/someone/claude-bot" }],
    ["Bash", { file_path: "/home/someone/inbox/items.json" }], // not a file tool: checkCommand's job
  ] as const) {
    expect(checkInboxAccess(tool, input).verdict).toBe("allow");
  }
});

test("relative paths are judged from the turn's working folder", () => {
  const cwd = "/home/someone/claude-bot";
  for (const [tool, input] of [
    ["Grep", { pattern: "http", path: ".." }],
    ["Grep", { pattern: "http", path: "../.." }],
    ["Glob", { pattern: "../*/items.json" }],
    ["Glob", { pattern: "/home/someone/*/files/*.jpg" }],
    ["Read", { file_path: "../inbox/items.json" }],
    ["Grep", { pattern: "x", glob: "../**/*.json" }],
    ["Glob", { pattern: "../inb*/items.json" }],
    ["Glob", { pattern: "/home/someone/inb*/files/*" }],
    ["Glob", { pattern: "~/**/*.json" }], // a home prefix is not relative to the working folder
  ] as const) {
    expect(checkInboxAccess(tool, input, cwd).verdict).toBe("block");
  }
  for (const [tool, input] of [
    ["Glob", { pattern: "**/*.ts" }],
    ["Read", { file_path: "inbox.ts" }],
    ["Grep", { pattern: "inbox", path: "docs" }],
    ["Read", { file_path: "../claude-bot/README.md" }],
  ] as const) {
    expect(checkInboxAccess(tool, input, cwd).verdict).toBe("allow");
  }
  // without a working folder, a path that climbs is refused rather than guessed at
  expect(checkInboxAccess("Grep", { pattern: "x", path: ".." }).verdict).toBe("block");
});

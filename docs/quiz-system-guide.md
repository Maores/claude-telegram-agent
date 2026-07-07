# Daily Quiz Bot — How to Build It Yourself

This guide explains how the daily interview-prep quiz system works, so you can replicate it in your own Telegram bot.

---

## Overview

The bot sends one interview question per day (LeetCode / system-design / behavioral) at a fixed time. The user can answer, get hints, or reveal the solution — all via Telegram commands and inline buttons. System-design questions come with a diagram image.

The bot is built in **TypeScript + Bun**, runs as a long-lived process on a Linux server, and polls Telegram for messages (no webhooks).

---

## Question Database

All questions live in a single JSON file: `data/questions.json`.

**Total: 554 questions**

| Type | Count |
|------|-------|
| Algo (LeetCode) | 82 |
| Behavioral | 29 |
| Concept | 32 |
| System Design | 411 (400 with diagrams) |

### Question Schema

```typescript
interface Question {
  id: string;                    // e.g. "algo-blind75-22"
  type: "algo" | "concept" | "behavioral" | "system-design";
  category: string;              // e.g. "linear-dp", "scalability"
  title: string;
  difficulty?: "easy" | "medium" | "hard";
  prompt: string;                // The actual question shown to user
  answer: string;                // Full model answer (shown on /reveal)
  hint?: string;                 // Up to 3 hints, separated by "||"
  solution_code?: string;        // Code sample for algo questions
  time_complexity?: string;
  space_complexity?: string;
  leetcode_url?: string;         // Link to LeetCode problem
  lc_description?: string;       // Full LeetCode problem statement
  source: string;                // Attribution
  tags: string[];
  diagram_url?: string;          // If set → flashcard mode (image + explanation, no quiz)
  pattern?: string;              // Pattern name (for pattern-recognition mode)
}
```

### Sample: Regular Algo Question

```json
{
  "id": "algo-blind75-22",
  "type": "algo",
  "category": "linear-dp",
  "title": "House Robber",
  "difficulty": "medium",
  "prompt": "Solve: House Robber\n\nWrite a solution and explain its time and space complexity.",
  "answer": "Share your approach — describe the algorithm in plain English, then explain the complexity. I'll evaluate it when you reply.",
  "hint": "Think about the choice at each house || Use DP: rob[i] = max(rob[i-2]+nums[i], rob[i-1]) || O(n) time, O(1) space",
  "source": "Blind 75 — ombharatiya/FAANG-Coding-Interview-Questions",
  "tags": ["blind75", "linear dp"],
  "lc_description": "You are a professional robber planning to rob houses along a street..."
}
```

### Sample: Diagram Question (Flashcard)

```json
{
  "id": "diagram-scalability-strategies",
  "type": "system-design",
  "category": "scalability",
  "title": "8 Scalability Strategies",
  "difficulty": "medium",
  "prompt": "Look at the diagram and name the 8 common strategies for scaling a system. For each — when would you use it and what is its main trade-off?",
  "answer": "1. Stateless services — remove server-side session state...\n2. Caching — Redis/Memcached...\n...",
  "hint": "Which strategy must come before horizontal scaling? || Which strategies reduce DB load directly? || What problem does async messaging solve?",
  "diagram_url": "https://assets.bytebytego.com/diagrams/0013-8-must-know-strategies-to-scale-your-system.png",
  "source": "ByteByteGo — system-design-101",
  "tags": ["system-design", "scalability", "architecture", "diagram"]
}
```

---

## Question Sources

All questions were pulled from open-source repos and public CDNs:

| Source | License | Content |
|--------|---------|---------|
| [yangshun/tech-interview-handbook](https://github.com/yangshun/tech-interview-handbook) | MIT | Behavioral questions |
| [ombharatiya/FAANG-Coding-Interview-Questions](https://github.com/ombharatiya/FAANG-Coding-Interview-Questions) | GPL-3.0 | Blind 75 algo questions |
| [ByteByteGo — system-design-101](https://github.com/ByteByteGo/system-design-101) | — | System design diagrams + guides |
| [dipjul/Grokking-the-Coding-Interview](https://github.com/dipjul/Grokking-the-Coding-Interview-Patterns-for-Coding-Questions) | MIT | Coding patterns |
| [Chanda-Abdul/Several-Coding-Patterns](https://github.com/Chanda-Abdul/Several-LeetCode-Patterns) | — | Pattern recognition |

### Diagram CDN

Diagram images are hosted by ByteByteGo on a public CDN. No download needed — Telegram fetches them by URL:

```
https://assets.bytebytego.com/diagrams/<filename>.png
```

Example filenames:
- `0013-8-must-know-strategies-to-scale-your-system.png`
- `0026-10-system-design-trade-offs-you-cannot-ignore.png`
- `0161-database-scaling-cheatsheet.png`
- `0019-9-best-practices-for-building-microservices.png`

Browse all diagrams in the [system-design-101 repo](https://github.com/ByteByteGo/system-design-101) — every chapter has a corresponding image on the CDN at the same slug.

---

## Scheduling: How Questions Are Sent

The bot has **no separate cron job** for quizzes. Instead, the main Telegram polling loop (which runs every ~30 seconds) calls `checkQuiz()` on every iteration.

`checkQuiz()` does nothing unless the current time matches the daily send window:

```typescript
// Weekdays (Sun–Thu): 18:00–18:30 local time
// Weekends (Fri–Sat): 10:00–10:30 local time
const TARGET_HOUR = isWeekend ? 10 : 18;

if (now.getHours() === TARGET_HOUR && now.getMinutes() < 30) {
  if (state.lastSentDate !== todayStr) {
    // Send the question
  }
}
```

`lastSentDate` in `data/quiz-state.json` prevents duplicate sends on the same day.

To **force-send** regardless of time, `/quiz` passes `force=true` to `checkQuiz()`.

### 7-Day Type Rotation

Questions cycle through types on a 7-day rotation:

```typescript
const ROTATION = ["algo", "concept", "algo", "behavioral", "algo", "system-design", "algo"];
```

`state.dayIndex` increments on each send and wraps with `% 7`.

### LeetCode Priority

Before picking from the rotation, the bot tries `pickLeetCodeQuestion()` first. If all LeetCode questions have been seen, it offers a fallback via inline button.

---

## Quiz State

State is stored in `data/quiz-state.json` and survives restarts:

```json
{
  "dayIndex": 3,
  "lastQuestionId": "algo-blind75-22",
  "awaitingAnswer": true,
  "lastSentDate": "2026-07-03",
  "seenIds": ["algo-blind75-1", "algo-blind75-2", "..."],
  "hintsUsed": 1,
  "attemptCount": 0,
  "unrelatedCount": 0
}
```

`seenIds` keeps the last 500 IDs so questions don't repeat. Once all questions in a category are seen, it resets and starts over.

---

## Daily Flow

```
18:00 (weekday)
  └─ Bot sends: "Daily LeetCode question ready — want to do it now?"
       [Yes, start] [No, skip today]
  
  If YES → Question is shown with /hint, /reveal, /skip buttons
  
  User types an answer → Claude evaluates it (algo / behavioral / system-design prompt)
  
  /hint → Shows next hint (up to 3)
  /reveal → Shows full answer + complexity
  
  After /reveal → "What next?"
       [Pattern question] [With diagram] [Continue normal]
```

---

## Telegram Commands

| Command | Behavior |
|---------|----------|
| `/quiz` | Force-send today's question now (bypasses time window) |
| `/hint` | Show next hint (max 3, requires active question) |
| `/reveal` | Show full answer |
| `/skip` | Skip current question |
| `/quiz_reset` | Wipe all state (dayIndex, seenIds, etc.) |

---

## Diagram Questions: How They're Sent

Diagram questions use `sendPhoto` instead of `sendMessage`:

```typescript
// Telegram API
POST https://api.telegram.org/bot{TOKEN}/sendPhoto
{
  chat_id: CHAT_ID,
  photo: "https://assets.bytebytego.com/diagrams/0013-...",
  caption: "Question text here (max 1024 chars)"
}
```

If the caption is too long: send the photo with no caption, then follow up with a separate text message.

Diagram questions are **flashcard mode** — the bot sends the image + explanation without waiting for a user answer. `awaitingAnswer` stays `false`.

---

## AI-Powered Answer Evaluation

When the user types a free-text answer (not a command), the bot:

1. Calls Claude to classify intent: is this a quiz answer or an unrelated message?
2. If quiz answer → routes to a type-specific evaluation prompt:
   - **Algo**: Check correctness, complexity, gap from optimal solution
   - **Concept**: Check completeness, flag missing points
   - **Behavioral**: Evaluate STAR structure (Situation, Task, Action, Result)
   - **System Design**: Evaluate components, scale reasoning, trade-offs
3. If unrelated: increments `unrelatedCount`; exits quiz mode after 3 unrelated messages

---

## Pause / Resume

To pause the daily auto-send without stopping the bot:

```bash
touch /path/to/bot/quiz-paused.flag   # pause
rm /path/to/bot/quiz-paused.flag      # resume
```

Manual `/quiz` still works while paused.

---

## File Structure

```
data/
  questions.json        # All 554 questions
  quiz-state.json       # Runtime state (auto-created)

lib/
  quiz-scheduler.ts     # checkQuiz(), formatQuestion(), sendPhoto(), type rotation
  quiz-state.ts         # State read/write, all pick*Question() functions

send-quiz-diagram-now.ts  # One-shot script to manually send a diagram question

poller.ts               # Main polling loop; wires up /quiz, /hint, /reveal, /skip commands
                        # and inline button callbacks (quiz_start, quiz_fallback, quiz_next)
```

---

## Quick Start Checklist

1. Clone or build your question database into `data/questions.json` using the schema above
2. Pull questions from the repos in the sources table; for diagrams, point `diagram_url` at ByteByteGo CDN URLs
3. Implement `checkQuiz()` in your polling loop (not a separate cron) — check time window, call `sendPhoto` for diagram questions, `sendMessage` for regular ones
4. Store state in `quiz-state.json` so it survives restarts
5. Wire up commands: `/quiz` (force-send), `/hint`, `/reveal`, `/skip`, `/quiz_reset`
6. Wire up callback buttons: `quiz_start:yes/no`, `quiz_fallback:yes/no`, `quiz_next:pattern/diagram/normal`
7. For answer evaluation: call Claude with a type-specific system prompt — behavioral gets STAR evaluation, algo gets complexity analysis, etc.
8. Optional: `quiz-paused.flag` file to pause auto-send without restarting the bot

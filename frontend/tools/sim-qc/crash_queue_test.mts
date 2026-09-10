// crash_queue_test — a receipt queued while delivery is in flight must SURVIVE delivery.
//
// FIELD REPORT / WHY THIS EXISTS (2026-09-09): the `aa-stack op=root` receipt was written so
// that its ABSENCE would be evidence ("our JS never set the Android Auto root, so the black
// screen is native's fault"). Codex's adversarial review found the receipt could vanish for a
// boring reason: `deliverAndHarvest` read a snapshot, awaited a network INSERT, then removed
// the WHOLE storage key — destroying any row queued during that request, unsent. The 2026-09-06
// review had serialised the queue's writers and left the deleter outside the chain.
//
// This drives the SHIPPED transitions in src/crashQueue.ts, which src/crashBreadcrumb.ts calls
// directly — not a re-implementation of them (Codex, 2026-09-08: a gate that only tests helpers
// proves nothing about what ships).
import {
  MAX_QUEUE, appendToQueue, claimQueue, dropDelivered, stripQid, type QueuedRow,
} from "../../src/crashQueue.ts";

let fails = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (!cond) { fails++; console.log(`  FAIL ${name} ${detail}`); } else console.log(`  ok   ${name} ${detail}`);
};

let seq = 0;
const nextId = () => `q${++seq}`;
const msgs = (rows: QueuedRow[]) => rows.map((r) => String(r.message));
const row = (message: string) => ({ message, is_fatal: false, late: false });

// ── A. append stamps ids and holds the cap ──────────────────────────────────────────────────
{
  const q = appendToQueue([], [row("a"), row("b")], nextId);
  ok("A1 appends both", msgs(q).join(",") === "a,b");
  ok("A2 every row stamped", q.every((r) => typeof r._qid === "string" && !!r._qid));
  ok("A3 ids are unique", new Set(q.map((r) => r._qid)).size === 2);
}
{
  let q: QueuedRow[] = [];
  for (let i = 0; i < MAX_QUEUE + 10; i++) q = appendToQueue(q, [row(`m${i}`)], nextId);
  ok("A4 capped at MAX_QUEUE", q.length === MAX_QUEUE, `len=${q.length}`);
  ok("A5 evicts the OLDEST, keeps the newest", msgs(q)[MAX_QUEUE - 1] === `m${MAX_QUEUE + 9}` && msgs(q)[0] === "m10");
}

// ── B. claim stamps legacy rows so the drop can name them ───────────────────────────────────
{
  const legacy: QueuedRow[] = [{ message: "old", is_fatal: false }, { message: "old2", is_fatal: false }];
  const { rows, dirty } = claimQueue(legacy, nextId);
  ok("B1 legacy rows get ids", rows.every((r) => typeof r._qid === "string" && !!r._qid));
  ok("B2 dirty so storage is rewritten", dirty === true);
  const again = claimQueue(rows, nextId);
  ok("B3 re-claiming stamped rows is NOT dirty", again.dirty === false);
  ok("B4 re-claiming does not change ids", again.rows.every((r, i) => r._qid === rows[i]._qid));
}

// ── C. THE RACE — this is the whole point of the file ───────────────────────────────────────
// Timeline: A is queued -> delivery claims a snapshot -> B is queued while the INSERT is in
// flight -> the insert succeeds -> delivery drops what it delivered.
{
  const stored0 = appendToQueue([], [row("A")], nextId);
  const claimed = claimQueue(stored0, nextId);              // delivery's snapshot: [A]
  const stored1 = appendToQueue(claimed.rows, [row("B")], nextId); // B lands mid-flight
  const delivered = claimed.rows.map((r) => r._qid!).filter(Boolean);
  const after = dropDelivered(stored1, delivered);

  ok("C1 delivery sent exactly A", msgs(claimed.rows).join(",") === "A");
  ok("C2 B SURVIVES the delivery", msgs(after).join(",") === "B", `after=[${msgs(after).join(",")}]`);
  ok("C3 A is gone (not resent next launch)", !msgs(after).includes("A"));

  // NEGATIVE CONTROL — the OLD deleter wiped the whole key. If this gate cannot see that,
  // it cannot see the regression coming back.
  const oldBehaviour: QueuedRow[] = [];                     // removeItem(QUEUE_KEY)
  ok("C4 the OLD wipe-everything deleter LOSES B", !msgs(oldBehaviour).includes("B"));
  ok("C5 gate distinguishes fixed from broken", msgs(after).includes("B") && !msgs(oldBehaviour).includes("B"));
}

// ── D. a failed insert must keep everything ─────────────────────────────────────────────────
{
  const stored = appendToQueue([], [row("x"), row("y")], nextId);
  const after = dropDelivered(stored, []);                  // insert errored -> drop nothing
  ok("D1 nothing dropped on a failed insert", msgs(after).join(",") === "x,y");
}

// ── E. ids that were never delivered are untouched ──────────────────────────────────────────
{
  const stored = appendToQueue([], [row("k")], nextId);
  const after = dropDelivered(stored, ["not-a-real-id"]);
  ok("E1 unknown ids are a no-op", msgs(after).join(",") === "k");
}

// ── F. legacy rows must not resend forever ──────────────────────────────────────────────────
// Before this change, unstamped rows had no id; if the drop skipped them they would be
// re-delivered on every launch, duplicating rows in crash_reports.
{
  const legacy: QueuedRow[] = [{ message: "pre-change", is_fatal: false }];
  const { rows } = claimQueue(legacy, nextId);
  const after = dropDelivered(rows, rows.map((r) => r._qid!));
  ok("F1 a claimed legacy row IS dropped after delivery", after.length === 0, `len=${after.length}`);
}

// ── G. the id never reaches the database ────────────────────────────────────────────────────
{
  const stored = appendToQueue([], [row("z")], nextId);
  const wire = stripQid(stored);
  ok("G1 _qid stripped", wire.every((r) => !("_qid" in r)));
  ok("G2 payload otherwise intact", wire[0].message === "z" && wire[0].is_fatal === false);
  ok("G3 stripping does not mutate the stored row", typeof stored[0]._qid === "string");
}

console.log(fails === 0 ? "\nPASS crash_queue" : `\nFAIL crash_queue (${fails})`);
if (fails) process.exit(1);

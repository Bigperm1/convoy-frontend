// crashQueue — the PURE state transitions of the offline crash/breadcrumb queue.
//
// Dependency-free on purpose (no React, no RN, no AsyncStorage, no imports), so
// `tools/sim-qc/crash_queue_test.mts` drives THIS EXACT CODE under plain Node instead of a
// copy of it. src/crashBreadcrumb.ts owns the storage I/O and the serialisation chain and
// calls straight into these functions — a gate that only exercised a re-implementation
// would prove nothing about what ships (Codex, 2026-09-08, on a previous gate of mine).
//
// WHY THIS FILE EXISTS (Codex adversarial review, 2026-09-09)
// The 2026-09-06 review serialised the queue's WRITERS but left the DELETER outside the
// chain: delivery read a snapshot, awaited a network INSERT, then removed the whole storage
// key — silently destroying any row queued during that in-flight request. Those rows were
// never sent. For an instrument whose ABSENCE is read as evidence (`aa-stack op=root`:
// "our JS never set the Android Auto root, so blame the native side"), a row that can
// vanish for a boring reason makes absence lie. Delivery now drops only the ids it
// actually delivered.

/** Keep the LAST N rows. A cap of 5 once threw away everything real; see crashBreadcrumb. */
export const MAX_QUEUE = 25;

/** A queued row. `_qid` is CLIENT-SIDE ONLY and is stripped before the insert. */
export type QueuedRow = { _qid?: string; [k: string]: unknown };

/** Append new rows (each stamped with a fresh id) and hold the queue at MAX_QUEUE. */
export function appendToQueue<T extends object>(
  cur: QueuedRow[], reports: T[], nextId: () => string,
): QueuedRow[] {
  const stamped = reports.map((r) => ({ ...r, _qid: nextId() }));
  return [...cur, ...stamped].slice(-MAX_QUEUE);
}

/**
 * What delivery CLAIMS: every row, with any unstamped legacy row given an id so the drop
 * that follows can name it. `dirty` says whether storage has to be rewritten.
 */
export function claimQueue(cur: QueuedRow[], nextId: () => string): { rows: QueuedRow[]; dirty: boolean } {
  let dirty = false;
  const rows = cur.map((r) => {
    if (r && typeof r._qid === "string" && r._qid) return r;
    dirty = true;
    return { ...r, _qid: nextId() };
  });
  return { rows, dirty };
}

/**
 * Drop EXACTLY the delivered ids. Anything queued while the insert was in flight carries
 * an id that is not in `ids`, so it survives to the next launch — that is the whole fix.
 */
export function dropDelivered(cur: QueuedRow[], ids: string[]): QueuedRow[] {
  if (!ids.length) return cur;
  const gone = new Set(ids);
  return cur.filter((r) => !(r && typeof r._qid === "string" && gone.has(r._qid)));
}

/** The rows as they go to the database: no `_qid` column exists there. */
export function stripQid(rows: QueuedRow[]): Record<string, unknown>[] {
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(r)) if (k !== "_qid") out[k] = (r as Record<string, unknown>)[k];
    return out;
  });
}

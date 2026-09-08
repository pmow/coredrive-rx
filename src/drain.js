// Publishing the offline queue. Extracted from app.js because this is the one path
// where a bug loses or duplicates field data, and it needs to be testable against a
// link that dies mid-flush.
//
// The design it replaces collected every published id and removed them only after
// the whole loop finished:
//
//   for (const r of rows) { await publish(r); done.push(r.id); }
//   if (done.length) { await queue.remove(done); }
//
// One rejecting publish threw out of the loop, so `queue.remove` never ran and every
// record the broker had ALREADY acknowledged stayed queued and was published again.
// Worse, it made progress impossible on a flaky link: publishes are sequential, so a
// 59-record backlog needs ~5 s of continuous connectivity at 86 ms round-trip and
// ~18 s at 300 ms. Observed in the field on a link that stayed up for about one
// second at a time — the queue could never commit anything at all.
//
// Two rules follow, and the tests below pin both:
//   1. A record is removed if and only if the broker acknowledged it. Progress is
//      committed as it is made, so a link that dies mid-flush keeps what it earned.
//   2. One record that cannot be published must never block the records behind it.

export const COMMIT_EVERY = 10; // ids per queue.remove — bounds re-publishing on a crash to <10
export const POISON_AFTER = 3;  // consecutive failures before a record is stepped over

// drainOnce publishes as much of the queue as the link allows, exactly once.
//
// deps:
//   queue     { takeAll(), remove(ids) }
//   publisher { connected(), publish(pubkey, rec, name) }  — publish rejects on failure
//   pubkey, name  identify this observer in the payload
//   failures  Map<id, count> of consecutive publish failures, owned by the caller so it
//             survives across drains (a poison record must be recognised over time)
//   log       (msg, level) optional
//
// Returns { published, committed, skipped, stopped } where `stopped` says why the
// pass ended: 'done' | 'link' | 'error'.
export async function drainOnce({ queue, publisher, pubkey, name, failures, log }) {
  const note = log || (() => {});
  if (!(publisher && publisher.connected() && pubkey)) {
    return { published: 0, committed: 0, skipped: 0, stopped: 'link' };
  }

  const rows = await queue.takeAll();
  const pending = [];      // acked ids not yet removed from the queue
  let published = 0;
  let committed = 0;
  let skipped = 0;
  let stopped = 'done';

  // commit is called as progress accumulates AND on every exit path, so an
  // acknowledged record is never left in the queue to be sent twice.
  const commit = async () => {
    if (!pending.length) return;
    const ids = pending.splice(0, pending.length);
    await queue.remove(ids);
    committed += ids.length;
  };

  try {
    for (const r of rows) {
      // Re-check the link before every record: it is the whole point of committing
      // incrementally that a mid-flush drop keeps what was already delivered.
      if (!publisher.connected()) { stopped = 'link'; break; }
      try {
        await publisher.publish(pubkey, r, name);
      } catch (e) {
        // A publish that failed because the LINK went down says nothing about the
        // record, so it must not count as a strike against it — three drops in a row
        // would otherwise quarantine a perfectly good reception. Stop the pass and
        // retry the same record once there is a connection again.
        if (!publisher.connected()) {
          note('link dropped mid-publish (' + e.message + ') — ' + (rows.length - published - skipped) + ' record(s) still queued', 'no');
          stopped = 'link';
          break;
        }
        const n = (failures.get(r.id) ?? 0) + 1;
        failures.set(r.id, n);
        if (n < POISON_AFTER) {
          // Most failures are the link, not the record. Stop and retry this same
          // record on the next pass rather than burning an 8 s publish timeout on
          // every remaining row against a socket that is already gone.
          note('publish failed (' + e.message + ') — ' + (rows.length - published - skipped) + ' record(s) still queued', 'no');
          stopped = 'error';
          break;
        }
        // Failed POISON_AFTER times in a row: treat it as unpublishable and step
        // over it, or it blocks every record behind it forever.
        skipped++;
        note('record #' + r.id + ' failed ' + n + '× — skipping it so it cannot block the queue', 'no');
        continue;
      }
      failures.delete(r.id);
      pending.push(r.id);
      published++;
      if (pending.length >= COMMIT_EVERY) await commit();
    }
  } finally {
    await commit();
  }

  return { published, committed, skipped, stopped };
}

/**
 * Conservative merge-queue election model. This module is a decision engine, not
 * a check publisher or distributed lock. Callers must not treat defer, stale,
 * or unknown as a successful required E2E check.
 */
const sha = v => typeof v === 'string' && /^[a-f\d]{40}$/i.test(v);
const limit = n => Number.isInteger(n) && n >= 1 && n <= 100;

export function inspectSnapshot(snapshot, { buildLimit, mergeLimit }) {
    const unknown = reason => ({ kind: 'unknown', reason });
    if (!limit(buildLimit) || !limit(mergeLimit)) return unknown('invalid_limits');
    if (!snapshot || !Array.isArray(snapshot.nodes) || snapshot.hasNextPage !== false)
        return unknown('incomplete_snapshot');
    if (!snapshot.nodes.length) return { kind: 'empty' };
    const seenHeads = new Set();
    const seenPrs = new Set();
    let priorHead = null;
    let incomplete = false;
    let groupClosed = false;
    const buildable = [];
    for (let i = 0; i < snapshot.nodes.length; i++) {
        const e = snapshot.nodes[i];
        if (!e || e.position !== i + 1 || !Number.isInteger(e.pr) || e.pr < 1 || typeof e.solo !== 'boolean')
            return unknown('invalid_entry');
        if (seenPrs.has(e.pr)) return unknown('duplicate_pr');
        seenPrs.add(e.pr);
        if (!['QUEUED', 'AWAITING_CHECKS', 'MERGEABLE', 'LOCKED', 'UNMERGEABLE'].includes(e.state))
            return unknown('invalid_state');
        if (e.state === 'QUEUED' && e.head == null && e.base == null) {
            // Wait for candidates still within the buildable window: otherwise
            // event ordering could elect a prefix before GitHub forms its head.
            if (i < Math.min(buildLimit, mergeLimit) && !groupClosed)
                return unknown('buildable_candidate_not_ready');
            incomplete = true;
            continue;
        }
        if (!sha(e.head) || !sha(e.base)) return unknown('invalid_candidate_sha');
        const head = e.head.toLowerCase(), base = e.base.toLowerCase();
        if (seenHeads.has(head)) return unknown('duplicate_head');
        seenHeads.add(head);
        // Queue transitions and locking invalidate election. HEADGREEN permits an
        // independently failed prefix if the complete combined candidate passes
        // every required check; preserve its exact SHA in the chain. Do not infer
        // a chain from a partially built or reordered snapshot.
        if (incomplete) return unknown('built_after_unbuilt');
        if (i > 0 && base !== priorHead) return unknown('inconsistent_chain');
        priorHead = head;
        if (!['AWAITING_CHECKS', 'MERGEABLE', 'UNMERGEABLE'].includes(e.state)) return unknown('unstable_state');
        // A solo entry splits a group. The event after a split must wait for the
        // first group's merge and rebuilt candidate; we cannot assert membership.
        if (i > 0 && e.solo) groupClosed = true;
        if (!groupClosed && i < Math.min(buildLimit, mergeLimit)) {
            buildable.push({ position: e.position, pr: e.pr, head, base, solo: e.solo });
            if (e.solo) groupClosed = true;
        }
    }
    if (!buildable.length) return unknown('no_buildable_head');
    // Stable signature covers every relevant member, not only the selected SHA.
    const signature = JSON.stringify(buildable);
    return { kind: 'candidates', buildable, signature, head: buildable.at(-1).head };
}

/**
 * Called repeatedly. Debounce from the first observation of the *current*
 * signature; queue API errors reset stability. The caller must use monotonic
 * timestamps. config deadline is short compared to GitHub's check timeout.
 */
export function decide({ snapshot, eventSha, nowMs, startedAtMs, stableSinceMs, priorSignature, config }) {
    if (!sha(eventSha) || !Number.isFinite(nowMs) || !Number.isFinite(startedAtMs) || nowMs < startedAtMs ||
        !Number.isFinite(config?.debounceMs) || config.debounceMs < 0 ||
        !Number.isFinite(config?.deadlineMs) || config.deadlineMs < config.debounceMs ||
        !limit(config?.buildLimit) || !limit(config?.mergeLimit)) {
        return { action: 'error', reason: 'invalid_context' };
    }
    const event = eventSha.toLowerCase();
    const view = inspectSnapshot(snapshot, config);
    const expired = nowMs - startedAtMs >= config.deadlineMs;
    if (view.kind === 'empty') return expired ? { action: 'stale', reason: 'empty_queue' } : { action: 'wait', reason: 'empty_queue', signature: null, stableSinceMs: null };
    if (view.kind === 'unknown') {
        // If observation is unavailable at deadline, fresh testing of event SHA is
        // safe but saves no work. GitHub itself must still reject obsolete SHAs.
        return expired ? { action: 'fallback', reason: view.reason } : { action: 'wait', reason: view.reason, signature: null, stableSinceMs: null };
    }
    const all = snapshot.nodes.filter(e => sha(e.head)).map(e => e.head.toLowerCase());
    if (!all.includes(event)) return expired ? { action: 'stale', reason: 'event_not_current' } : { action: 'wait', reason: 'event_not_current', signature: null, stableSinceMs: null };
    const inGroup = view.buildable.some(e => e.head === event);
    if (!inGroup) {
        return expired ? { action: 'fallback', reason: 'event_outside_first_group' } : { action: 'wait', reason: 'event_outside_first_group', signature: null, stableSinceMs: null };
    }
    let since = priorSignature === view.signature && Number.isFinite(stableSinceMs) && stableSinceMs <= nowMs
        ? stableSinceMs : nowMs;
    if (nowMs - since < config.debounceMs)
        return expired ? { action: 'fallback', reason: 'debounce_deadline' } : { action: 'wait', reason: 'debouncing', signature: view.signature, stableSinceMs: since };
    if (event === view.head) return { action: 'run', reason: 'elected_head', head: view.head, signature: view.signature, members: view.buildable };
    // No positive check may be issued for this prefix. Keep polling, cancellation,
    // or a separate controller may handle lifecycle without runner time.
    return expired ? { action: 'fallback', reason: 'prefix_deadline' } : { action: 'defer', reason: 'prefix', head: view.head, signature: view.signature, stableSinceMs: since };
}

/** Re-read immediately before beginning and before completing the head check. */
export function revalidate({ snapshot, eventSha, electedSignature, config, verifiedMerged = new Set() }) {
    if (!sha(eventSha) || typeof electedSignature !== 'string' || !(verifiedMerged instanceof Set)) return false;
    const view = inspectSnapshot(snapshot, config);
    if (view.kind !== 'candidates') return false;
    let elected;
    try { elected = JSON.parse(electedSignature); } catch { return false; }
    if (!Array.isArray(elected) || elected.length === 0 || elected.length > 100 ||
        elected.at(-1)?.head !== eventSha.toLowerCase() ||
        elected.some((e,i) => !e || e.position !== i + 1 || !Number.isInteger(e.pr) || e.pr < 1 ||
            !sha(e.head) || !sha(e.base) || typeof e.solo !== 'boolean')) return false;
    // Entries can vanish from the front after they really merge, shifting
    // positions while GitHub keeps this *exact* merge-group commit. Only allow
    // that if each missing PR was independently confirmed merged. Removal of
    // an unmerged PR is not equivalent and must fail closed.
    for (let offset=0; offset < elected.length; offset++) {
        const remaining = elected.slice(offset);
        if (remaining.length > view.buildable.length ||
            elected.slice(0, offset).some(e => !verifiedMerged.has(e.pr))) continue;
        const match = remaining.every((old,i) => {
            const cur = view.buildable[i];
            return cur.pr === old.pr && cur.head === old.head && cur.base === old.base && cur.solo === old.solo;
        });
        if (match) return true;
    }
    return false;
}

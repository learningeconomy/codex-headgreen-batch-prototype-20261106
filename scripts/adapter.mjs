import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decide, inspectSnapshot, revalidate } from './coordinator.mjs';

export const QUERY = `query Batch($owner:String!,$name:String!,$branch:String!) {
  repository(owner:$owner,name:$name) { mergeQueue(branch:$branch) {
    entries(first:100) { pageInfo { hasNextPage } nodes {
      position state solo headCommit { oid } baseCommit { oid } pullRequest { number }
    } }
  } }
}`;

export const MERGED_QUERY = `query CandidatePR($owner:String!,$name:String!,$number:Int!) {
  repository(owner:$owner,name:$name) { pullRequest(number:$number) { number merged } }
}`;

const isSha = v => typeof v === 'string' && /^[a-f\d]{40}$/i.test(v);
const integer = (v, min, max) => Number.isInteger(Number(v)) && String(v).trim() !== '' && Number(v) >= min && Number(v) <= max;

export function context(env, event) {
    const [owner, name, ...extra] = (env.GITHUB_REPOSITORY || '').split('/');
    const ref = event?.merge_group?.base_ref;
    if (env.GITHUB_EVENT_NAME !== 'merge_group' || !owner || !name || extra.length ||
        !ref?.startsWith('refs/heads/') || !ref.slice(11) ||
        !isSha(env.GITHUB_SHA) || event?.merge_group?.head_sha?.toLowerCase() !== env.GITHUB_SHA.toLowerCase())
        throw new Error('invalid merge group context');
    if (!env.GH_TOKEN || !env.GITHUB_OUTPUT) throw new Error('missing token or output path');
    if (!integer(env.BUILD_LIMIT,1,100) || !integer(env.MERGE_LIMIT,1,100) ||
        !integer(env.DEBOUNCE_MS,0,3600000) || !integer(env.DEADLINE_MS,1,3600000) ||
        !integer(env.POLL_MS,1,60000) || Number(env.DEADLINE_MS) < Number(env.DEBOUNCE_MS))
        throw new Error('invalid coordinator limits');
    return { owner, name, branch:ref.slice(11), eventSha:env.GITHUB_SHA.toLowerCase(), output:env.GITHUB_OUTPUT,
      config:{buildLimit:Number(env.BUILD_LIMIT), mergeLimit:Number(env.MERGE_LIMIT), debounceMs:Number(env.DEBOUNCE_MS), deadlineMs:Number(env.DEADLINE_MS)}, pollMs:Number(env.POLL_MS) };
}

/** A failed or incomplete API read is null, never an empty queue. */
export function parseResponse(value) {
    const connection = value?.data?.repository?.mergeQueue?.entries;
    if (value?.errors?.length || !Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') return null;
    return { hasNextPage:connection.pageInfo.hasNextPage, nodes:connection.nodes.map(e => ({
      position:e?.position, pr:e?.pullRequest?.number, head:e?.headCommit?.oid ?? null,
      base:e?.baseCommit?.oid ?? null, state:e?.state, solo:e?.solo,
    })) };
}

export function fetchQueue(ctx, exec = execFileSync) {
    try {
        const raw = exec('gh', ['api','graphql','-f',`query=${QUERY}`,'-f',`owner=${ctx.owner}`,'-f',`name=${ctx.name}`,'-f',`branch=${ctx.branch}`],
            {encoding:'utf8',timeout:8000,stdio:['ignore','pipe','pipe']});
        return parseResponse(JSON.parse(raw));
    } catch { return null; }
}

/** A merged PR is irreversible proof its previously observed candidate is obsolete. */
export function fetchMerged(ctx, number, exec = execFileSync) {
    try {
        const raw = exec('gh', ['api','graphql','-f',`query=${MERGED_QUERY}`,'-f',`owner=${ctx.owner}`,'-f',`name=${ctx.name}`,'-F',`number=${number}`],
            {encoding:'utf8',timeout:8000,stdio:['ignore','pipe','pipe']});
        const data = JSON.parse(raw);
        const pr = data?.data?.repository?.pullRequest;
        return !data?.errors?.length && pr?.number === number && pr?.merged === true;
    } catch { return false; }
}

/** Poll one event until elected or a bounded fresh-test fallback; never returns a prefix pass. */
export async function runCoordinator(ctx, {fetch = fetchQueue, merged = fetchMerged, clock = () => performance.now(), sleep = ms => new Promise(resolve => setTimeout(resolve,ms)), log = () => {}} = {}) {
    const startedAtMs = clock();
    let priorSignature = null, stableSinceMs = null, observedPr = null;
    for (;;) {
        const snapshot = await fetch(ctx);
        const nowMs = clock();
        const view = inspectSnapshot(snapshot, ctx.config);
        // Record identity only from a validated, complete snapshot, never from
        // ref-name guesses or malformed data. Once a PR is merged it cannot be
        // reopened, so an absent witnessed candidate plus a fresh merged=true
        // result proves this run no longer needs to wait. Failure or ambiguity
        // in either read simply retains normal wait/fallback behavior.
        if (view.kind === 'candidates') {
            const current = snapshot.nodes.find(entry => entry.head?.toLowerCase() === ctx.eventSha);
            if (current && observedPr !== null && observedPr !== current.pr)
                throw new Error('candidate SHA maps to conflicting pull requests');
            if (current) observedPr = current.pr;
        }
        if (observedPr !== null && (view.kind === 'empty' || view.kind === 'candidates') &&
            !(snapshot.nodes || []).some(entry => entry.head?.toLowerCase() === ctx.eventSha) &&
            await merged(ctx, observedPr)) {
            log('obsolete', 'witnessed_pr_merged');
            return {action:'obsolete', reason:'witnessed_pr_merged', pr:observedPr};
        }
        const result = decide({ snapshot, eventSha:ctx.eventSha, nowMs, startedAtMs, stableSinceMs, priorSignature, config:ctx.config });
        log(result.action, result.reason);
        if (result.action === 'run' || result.action === 'fallback') return result;
        if (result.action === 'stale' || result.action === 'error') throw new Error(`coordinator: ${result.action}: ${result.reason}`);
        priorSignature = result.signature ?? null;
        stableSinceMs = result.stableSinceMs ?? null;
        const remaining = Math.max(0, ctx.config.deadlineMs - (clock() - startedAtMs));
        await sleep(Math.min(ctx.pollMs, remaining));
    }
}

export async function main(env = process.env, args = process.argv.slice(2)) {
    if (!env.GITHUB_EVENT_PATH) throw new Error('missing event path');
    const ctx = context(env, JSON.parse(readFileSync(env.GITHUB_EVENT_PATH,'utf8')));
    if (args[0] === '--revalidate') {
        if (!env.ELECTED_SIGNATURE_BASE64) throw new Error('missing election signature');
        const signature = Buffer.from(env.ELECTED_SIGNATURE_BASE64, 'base64').toString('utf8');
        const snapshot = fetchQueue(ctx);
        const verifiedMerged = new Set();
        // Only missing PRs can represent shifted-away predecessors. A failed or
        // ambiguous lookup is not a merged proof and makes revalidation fail.
        try {
            const elected = JSON.parse(signature);
            if (Array.isArray(elected) && elected.length <= 100 && Array.isArray(snapshot?.nodes)) {
                const currentPrs = new Set(snapshot.nodes.map(node => node?.pr));
                for (const member of elected.slice(0,-1)) {
                    if (Number.isInteger(member?.pr) && member.pr > 0 && !currentPrs.has(member.pr) && fetchMerged(ctx, member.pr))
                        verifiedMerged.add(member.pr);
                }
            }
        } catch { /* Pure revalidation will reject malformed input. */ }
        if (!revalidate({snapshot,eventSha:ctx.eventSha,electedSignature:signature,config:ctx.config,verifiedMerged}))
            throw new Error('elected membership no longer current');
        console.log('Election membership remains current');
        return;
    }
    if (args.length) throw new Error('unknown argument');
    const result = await runCoordinator(ctx,{log:(action,reason) => console.log(`Coordinator: ${action}: ${reason}`)});
    if (result.action === 'obsolete') throw new Error('witnessed candidate PR was merged; this E2E attempt is obsolete');
    const encoded = Buffer.from(result.signature || '', 'utf8').toString('base64');
    // There is intentionally no run_test=false path. A stale or failed adapter
    // exits nonzero; a waiting prefix continues polling and can fall back to E2E.
    appendFileSync(ctx.output, `run_test=true\nelection=${result.action}\nevent_sha=${ctx.eventSha}\nsignature_base64=${encoded}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
    main().catch(err => { console.error(`Coordinator failed: ${err.message}`); process.exitCode=1; });
}

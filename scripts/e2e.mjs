import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const role = process.argv[2];
if (!['browser', 'shard-1', 'shard-2', 'shard-3'].includes(role)) throw new Error('Invalid suite role');
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
console.log(`SUITE_STARTED role=${role} sha=${sha}`);
if (fs.existsSync('features/coordinator-slow.txt')) await sleep(45000);
if (fs.existsSync('features/coordinator-fail.txt') && fs.readFileSync('features/coordinator-fail.txt', 'utf8').trim() === role) {
    throw new Error(`Intentional synthetic failure: ${role}`);
}
const members = fs.readdirSync('features').filter(name => name.startsWith('coord-')).sort();
const values = members.map(name => fs.readFileSync(`features/${name}`, 'utf8').trim());
if (role === 'browser') {
    const path = '/tmp/headgreen-coordinator.html';
    const expected = `synthetic-members-${members.length}`;
    fs.writeFileSync(path, `<!doctype html><title>Queue</title><main>${expected}</main>`);
    const html = execFileSync('google-chrome', ['--headless', '--no-sandbox', '--disable-gpu', '--dump-dom', `file://${path}`], { encoding: 'utf8' });
    if (!html.includes(`<main>${expected}</main>`)) throw new Error('Browser rendering failed');
} else {
    if (values.some(value => !value.startsWith('synthetic case='))) throw new Error('Invalid synthetic member');
}
console.log(`SUITE_PASSED role=${role} sha=${sha} members=${members.length}`);

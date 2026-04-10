import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runActionSmoke(input) {
    const { stdout } = await execFileAsync('node', ['--import', 'tsx', 'scripts/run-action-smoke.mjs', JSON.stringify(input)], {
        cwd: process.cwd(),
        env: process.env,
        maxBuffer: 20 * 1024 * 1024,
    });

    const jsonStart = stdout.lastIndexOf('\n{') >= 0 ? stdout.lastIndexOf('\n{') + 1 : stdout.indexOf('{');
    if (jsonStart < 0) {
        throw new Error(`Smoke runner did not return JSON for action ${input.action}`);
    }

    return JSON.parse(stdout.slice(jsonStart));
}

export function assertSmoke(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
}

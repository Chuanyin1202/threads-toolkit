import fs from 'node:fs/promises';

import { assertSmoke, runActionSmoke } from './smoke-lib.mjs';

async function loadStorageState() {
    if (process.env.THREADS_STORAGE_STATE_JSON) {
        return JSON.parse(process.env.THREADS_STORAGE_STATE_JSON);
    }

    if (process.env.THREADS_STORAGE_STATE_PATH) {
        const raw = await fs.readFile(process.env.THREADS_STORAGE_STATE_PATH, 'utf8');
        return JSON.parse(raw);
    }

    throw new Error('Set THREADS_STORAGE_STATE_PATH or THREADS_STORAGE_STATE_JSON before running smoke:auth');
}

const storageState = await loadStorageState();

const result = await runActionSmoke({
    action: 'profile',
    username: 'zuck',
    includePosts: false,
    useCookies: true,
    storageState,
    proxyConfiguration: { useApifyProxy: false },
});

assertSmoke(!result.error, `auth profile failed: ${result.error}`);
assertSmoke(result.itemCount >= 1, `auth profile expected at least 1 dataset item, got ${result.itemCount}`);
assertSmoke(result.firstItem?.displayName === 'Mark Zuckerberg', 'auth profile displayName mismatch');
assertSmoke(result.firstItem?.followersCount && result.firstItem.followersCount > 1000000, 'auth profile followersCount missing');
assertSmoke(result.firstItem?.location === 'United States', `auth profile location mismatch: ${result.firstItem?.location}`);
assertSmoke(result.firstItem?.joinedDate === 'July 2023', `auth profile joinedDate mismatch: ${result.firstItem?.joinedDate}`);

console.log(JSON.stringify({
    ok: true,
    run: 'auth-profile',
    itemCount: result.itemCount,
    firstItem: result.firstItem,
}, null, 2));

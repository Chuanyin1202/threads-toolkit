import { Actor } from 'apify';
import { Dataset, Log } from 'crawlee';

import { hashtagAction, postAction, profileAction, searchAction } from '../src/actions/index.ts';

const input = JSON.parse(process.argv[2] || '{}');
const log = new Log({ prefix: 'Smoke' });
const collected = [];

Dataset.pushData = async (item) => {
    collected.push(item);
};
Actor.createProxyConfiguration = async () => undefined;

function summarizeFirstItem(item) {
    if (!item) return null;

    return {
        type: item.type || item.source || null,
        id: item.id || null,
        username: item.username || item.author?.username || null,
        displayName: item.displayName || item.author?.displayName || null,
        hasContent: Boolean(item.content),
        hasTimestamp: Boolean(item.timestamp),
        partial: item.partial || false,
        location: item.location || null,
        joinedDate: item.joinedDate || null,
        followersCount: item.followersCount ?? null,
    };
}

let error = null;
try {
    switch (input.action) {
        case 'profile':
            await profileAction(input, log);
            break;
        case 'post':
            await postAction(input, log);
            break;
        case 'search':
            await searchAction(input, log);
            break;
        case 'hashtag':
            await hashtagAction(input, log);
            break;
        default:
            throw new Error(`Unknown action: ${input.action}`);
    }
} catch (err) {
    error = err instanceof Error ? err.message : String(err);
}

console.log(JSON.stringify({
    action: input.action,
    itemCount: collected.length,
    firstItem: summarizeFirstItem(collected[0]),
    error,
}, null, 2));

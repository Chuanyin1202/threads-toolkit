import { assertSmoke, runActionSmoke } from './smoke-lib.mjs';

const runs = [
    {
        name: 'profile',
        input: { action: 'profile', username: 'zuck', includePosts: true, maxItems: 3, proxyConfiguration: { useApifyProxy: false } },
        validate(result) {
            assertSmoke(!result.error, `profile failed: ${result.error}`);
            assertSmoke(result.itemCount >= 4, `profile expected at least 4 dataset items, got ${result.itemCount}`);
            assertSmoke(result.firstItem?.type === 'profile', 'profile first item should be profile');
            assertSmoke(result.firstItem?.displayName === 'Mark Zuckerberg', 'profile displayName mismatch');
            assertSmoke(result.firstItem?.followersCount && result.firstItem.followersCount > 1000000, 'profile followersCount missing');
        },
    },
    {
        name: 'post',
        input: {
            action: 'post',
            postUrl: 'https://www.threads.com/@zuck/post/DW4Gb79kQc0',
            maxItems: 5,
            proxyConfiguration: { useApifyProxy: false },
        },
        validate(result) {
            assertSmoke(!result.error, `post failed: ${result.error}`);
            assertSmoke(result.itemCount >= 5, `post expected at least 5 dataset items, got ${result.itemCount}`);
            assertSmoke(result.firstItem?.id === 'DW4Gb79kQc0', 'post first item id mismatch');
            assertSmoke(result.firstItem?.displayName === 'Mark Zuckerberg', 'post displayName mismatch');
            assertSmoke(result.firstItem?.hasContent, 'post content missing');
            assertSmoke(result.firstItem?.hasTimestamp, 'post timestamp missing');
        },
    },
    {
        name: 'search-recent',
        input: { action: 'search', keyword: 'ai', filter: 'recent', maxItems: 5, proxyConfiguration: { useApifyProxy: false } },
        validate(result) {
            assertSmoke(!result.error, `search recent failed: ${result.error}`);
            assertSmoke(result.itemCount >= 1, `search recent expected at least 1 result, got ${result.itemCount}`);
            assertSmoke(result.firstItem?.hasContent, 'search recent first item content missing');
            assertSmoke(result.firstItem?.hasTimestamp, 'search recent first item timestamp missing');
        },
    },
    {
        name: 'search-top',
        input: { action: 'search', keyword: 'ai', filter: 'top', maxItems: 5, proxyConfiguration: { useApifyProxy: false } },
        validate(result) {
            assertSmoke(!result.error, `search top failed: ${result.error}`);
            assertSmoke(result.itemCount >= 1, `search top expected at least 1 result, got ${result.itemCount}`);
        },
    },
    {
        name: 'hashtag-recent',
        input: { action: 'hashtag', tag: 'ai', filter: 'recent', maxItems: 5, proxyConfiguration: { useApifyProxy: false } },
        validate(result) {
            assertSmoke(!result.error, `hashtag recent failed: ${result.error}`);
            assertSmoke(result.itemCount >= 1, `hashtag recent expected at least 1 result, got ${result.itemCount}`);
            assertSmoke(result.firstItem?.hasContent, 'hashtag recent first item content missing');
        },
    },
    {
        name: 'hashtag-top',
        input: { action: 'hashtag', tag: 'ai', filter: 'top', maxItems: 5, proxyConfiguration: { useApifyProxy: false } },
        validate(result) {
            assertSmoke(!result.error, `hashtag top failed: ${result.error}`);
            assertSmoke(result.itemCount >= 1, `hashtag top expected at least 1 result, got ${result.itemCount}`);
        },
    },
];

const summaries = [];
for (const run of runs) {
    const result = await runActionSmoke(run.input);
    run.validate(result);
    summaries.push({
        name: run.name,
        itemCount: result.itemCount,
        firstItem: result.firstItem,
    });
}

console.log(JSON.stringify({ ok: true, runs: summaries }, null, 2));

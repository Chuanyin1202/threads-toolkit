import assert from 'node:assert/strict';
import test from 'node:test';

import type { ProfileData,ThreadsPost } from '../src/types.js';
import { validatePost, validateProfile } from '../src/utils/page-helpers.js';
import { parseRelativeTime, parseStatNumber } from '../src/utils/parser.js';
import { buildSelector } from '../src/utils/selectors.js';

function makePost(overrides: Partial<ThreadsPost> = {}): ThreadsPost {
    return {
        id: 'post_1',
        url: 'https://www.threads.com/@alice/post/abc123',
        author: {
            username: 'alice',
            displayName: 'Alice',
            profileUrl: 'https://www.threads.com/@alice',
        },
        content: 'hello world',
        timestamp: '2026-04-10T00:00:00.000Z',
        stats: { likes: 1, replies: 2, reposts: 3, shares: 4 },
        ...overrides,
    };
}

function makeProfile(overrides: Partial<ProfileData> = {}): ProfileData {
    return {
        username: 'alice',
        displayName: 'Alice',
        profileUrl: 'https://www.threads.com/@alice',
        isVerified: false,
        ...overrides,
    };
}

void test('buildSelector joins selector parts with commas', () => {
    assert.equal(buildSelector('a[href]', 'button[role="button"]'), 'a[href], button[role="button"]');
});

void test('validatePost rejects missing content, author, or timestamp', () => {
    assert.deepEqual(validatePost(makePost({ content: '' })), { valid: false, reason: 'noContent' });
    assert.deepEqual(
        validatePost(makePost({ author: { username: 'unknown', displayName: 'unknown', profileUrl: '' } })),
        { valid: false, reason: 'noAuthor' }
    );
    assert.deepEqual(validatePost(makePost({ timestamp: '' })), { valid: false, reason: 'noTimestamp' });
    assert.deepEqual(validatePost(makePost()), { valid: true });
});

void test('validateProfile marks missing optional fields as partial', () => {
    const result = validateProfile(makeProfile());
    assert.equal(result.valid, true);
    assert.equal(result.partial, true);
    assert.ok(result.missing?.includes('avatarUrl'));
    assert.ok(result.missing?.includes('followersCount'));
});

void test('parseStatNumber handles plain, K, and M formats', () => {
    assert.equal(parseStatNumber('讚 2,049'), 2049);
    assert.equal(parseStatNumber('1.5K likes'), 1500);
    assert.equal(parseStatNumber('2M'), 2000000);
});

void test('parseRelativeTime handles known relative formats and empty input', () => {
    assert.equal(parseRelativeTime(''), '');

    const justNow = parseRelativeTime('just now');
    assert.match(justNow, /^\d{4}-\d{2}-\d{2}T/);

    const fiveMinutesAgo = new Date(parseRelativeTime('5m'));
    assert.ok(Number.isFinite(fiveMinutesAgo.getTime()));

    const twoDaysAgoZh = new Date(parseRelativeTime('2天前'));
    assert.ok(Number.isFinite(twoDaysAgoZh.getTime()));
});

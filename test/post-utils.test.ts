import assert from 'node:assert/strict';
import test from 'node:test';

import { extractPostId, normalizePostUrl } from '../src/actions/post.js';

void test('normalizePostUrl normalizes threads.net and missing protocol', () => {
    assert.equal(
        normalizePostUrl('threads.net/@alice/post/Cu12345'),
        'https://threads.com/@alice/post/Cu12345'
    );
    assert.equal(
        normalizePostUrl('https://www.threads.com/@alice/post/Cu12345'),
        'https://www.threads.com/@alice/post/Cu12345'
    );
});

void test('normalizePostUrl rejects non-threads urls', () => {
    assert.equal(normalizePostUrl('https://example.com/post/123'), null);
});

void test('extractPostId returns post id from valid threads url', () => {
    assert.equal(
        extractPostId('https://www.threads.com/@alice/post/Cu12345_xyz'),
        'Cu12345_xyz'
    );
    assert.equal(extractPostId('https://www.threads.com/@alice'), null);
});

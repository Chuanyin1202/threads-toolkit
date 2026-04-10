import assert from 'node:assert/strict';
import test from 'node:test';

import type { Page } from 'playwright';
import { chromium } from 'playwright';

import {
    extractPostsFromPage,
    extractProfileFromPage,
    extractSinglePostFromPage,
} from '../src/utils/parser.js';

const SEARCH_RESULTS_HTML = `
<!doctype html>
<html>
  <body>
    <div role="main">
      <div tabindex="0">
        <div>
          <a href="/@alice/post/abc123"><span>Open post</span></a>
          <a href="/@alice"><span>Alice Example</span></a>
          <img alt="profile picture" src="https://cdn.example.com/alice.jpg" />
          <div dir="auto">This is the main post content for Alice on Threads.</div>
          <time datetime="2026-04-10T08:30:00.000Z">2h</time>
          <div role="button">Like 12</div>
          <div role="button">Comment 3</div>
          <div role="button">Repost 1</div>
        </div>
      </div>
      <div tabindex="0">
        <div>
          <a href="/@bob/post/def456"><span>Open post</span></a>
          <a href="/@bob"><span>Bob Example</span></a>
          <div dir="auto">Bob shares another valid post body for parsing tests.</div>
          <time datetime="2026-04-09T20:00:00.000Z">12h</time>
          <div role="button">Like 5</div>
          <div role="button">Comment 1</div>
        </div>
      </div>
    </div>
  </body>
</html>
`;

const PROFILE_HTML = `
<!doctype html>
<html>
  <body>
    <div role="region">
      <h1>Alice Example</h1>
      <img alt="profile picture" src="https://cdn.example.com/alice.jpg" />
      <a href="/followers">1.5K followers</a>
      <div dir="auto">Builder, writer, and Threads test profile.</div>
    </div>
  </body>
</html>
`;

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.setContent(html, { waitUntil: 'domcontentloaded' });
        return await fn(page);
    } finally {
        await browser.close();
    }
}

void test('extractPostsFromPage parses post cards from fixture HTML', async () => {
    const posts = await withPage(SEARCH_RESULTS_HTML, async (page) => extractPostsFromPage(page, 10));

    assert.equal(posts.length, 2);
    assert.equal(posts[0].id, 'abc123');
    assert.equal(posts[0].author.username, 'alice');
    assert.equal(posts[0].author.displayName, 'Alice Example');
    assert.equal(posts[0].content, 'This is the main post content for Alice on Threads.');
    assert.equal(posts[0].stats.likes, 12);
    assert.equal(posts[0].stats.replies, 3);
});

void test('extractProfileFromPage parses profile fixture HTML', async () => {
    const profile = await withPage(PROFILE_HTML, async (page) => extractProfileFromPage(page, 'alice'));

    assert.ok(profile);
    assert.equal(profile?.username, 'alice');
    assert.equal(profile?.displayName, 'Alice Example');
    assert.equal(profile?.followersCount, 1500);
    assert.equal(profile?.bio, 'Builder, writer, and Threads test profile.');
});

void test('extractSinglePostFromPage parses a dedicated post page fixture', async () => {
    const post = await withPage(SEARCH_RESULTS_HTML, async (page) =>
        extractSinglePostFromPage(page, 'abc123', 'https://www.threads.com/@alice/post/abc123')
    );

    assert.ok(post);
    assert.equal(post?.id, 'abc123');
    assert.equal(post?.url, 'https://www.threads.com/@alice/post/abc123');
    assert.equal(post?.author.username, 'alice');
});

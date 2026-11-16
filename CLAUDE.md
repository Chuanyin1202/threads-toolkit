# CLAUDE.md

Apify Actor (TypeScript, Crawlee + Playwright) that scrapes Threads (threads.com, Meta). General Apify conventions live in `AGENTS.md`; this file covers what is specific to this repo.

## Commands

```bash
npm run start:dev      # run locally via tsx (reads storage/key_value_stores/default/INPUT.json)
apify run              # same, through Apify CLI
npm run build          # tsc -> dist/ (Docker runs dist/main.js)
npm run lint           # eslint (@apify config + prettier)
npm test               # node:test via tsx: unit + fixture-based parser tests (launches headless Chromium)
node --import tsx --test test/utils.test.ts   # single test file
npm run smoke:live     # LIVE scraping of real Threads pages (network, slow, can flake)
npm run smoke:auth     # needs THREADS_STORAGE_STATE_PATH or THREADS_STORAGE_STATE_JSON
```

Before finishing a change, run `npm run build`, `npm run lint` and `npm test`. Run smoke tests only when the change touches scraping/parsing behaviour against the live site, and tell the user that they hit the real network.

## Architecture

- `src/main.ts` — entry. Reads input; if any of `keywords`/`usernames`/`tags`/`postUrls` is an array → **batch mode** (expands into single tasks, runs them with a simple worker pool, `concurrency` default 2, failures are logged and don't fail the run). Otherwise validates `action` and dispatches to one action.
- `src/actions/{search,hashtag,profile,post}.ts` — one `PlaywrightCrawler` per action, each a single page (`maxRequestsPerCrawl: 1`). Each file repeats the same scaffolding: proxy from `Actor.createProxyConfiguration`, `preNavigationHooks` (block images/fonts/media, request delay, exponential backoff on retry), optional cookie/localStorage injection from `storageState` in `postPageCreateHooks` (Threads origins only; sessionStorage is ignored). A change to this scaffolding usually has to be made in all four files.
  - Every crawler **must** use its own queue from `openIsolatedQueue()` and be run via `runSingleRequestCrawl()` (`src/utils/crawler-helpers.ts`). With the shared default queue, batch tasks after the first hit `maxRequestsPerCrawl: 1` without running and parallel tasks steal each other's requests. `runSingleRequestCrawl` drops the queue and throws if the request failed, which is how batch mode counts failures.
  - Search/hashtag posts are pushed with `source` + `keyword`/`tag` so batch output can be split by query.
  - `search`/`hashtag` → `https://www.threads.com/search?...` (hashtag is a search with `#tag`), scroll, extract posts.
  - `profile` → `/@username`; pushes a profile item (`type: 'profile'`) and, if `includePosts`, posts with `source: 'profile_posts'`. `location`/`joinedDate` are only fetched via the "About this profile" dialog when authenticated, otherwise `null`.
  - `post` → normalizes URL (`threads.net` → `threads.com`), pushes the main post, then replies with `source: 'reply'`, `parentId`.
- `src/utils/parser.ts` — **all DOM parsing** (posts, single post, profile, About dialog, relative time, `1.2K`/`3M` stat numbers). Pages are parsed with `page.evaluate`/locators; post containers are found by walking up from `a[href*="/post/"]` links. Some fields (display names, profile fields) are recovered from embedded JSON payloads in `<script type="application/json">`.
- `src/utils/selectors.ts` — central selector map. Selectors are multilingual (English + Chinese UI text, e.g. `讚`, `留言`, `大頭貼照`); keep both languages when editing.
- `src/utils/page-helpers.ts` — error detection (login wall, rate limit, explicit "No results", error page; multilingual patterns matched against visible `innerText` only — inline `<script>` JSON contains words like "blocked"), `scrollForPosts`, `validatePost` (requires content ≥3 chars, author, timestamp — invalid posts are skipped, not pushed), `validateProfile` (only username required; marks `partial` + `missingFields`), `DEFAULT_RATE_LIMIT_CONFIG`, `RateLimitError`.
- `src/types.ts` — input/output types. Output shape: `ThreadsPost` (`id, url, author, content, timestamp, stats{likes,replies,reposts,shares}, images, videos, links`) and `ProfileData`.

Search URLs: Threads opens the **Top** tab by default; **Recent** is `&filter=recent` (there is no `filter=top`).

Scrolling (`scrollForPosts`) returns the posts it parsed along the way — Threads virtualizes the feed and unloads posts that scrolled out of view, so parsing once at the end loses most of them. Already-parsed IDs are skipped via `extractPostsFromPage(page, max, skipIds)`. Logged-out, the feed is in an inner scroll container; logged-in, the document scrolls and the only scrollable div is the sidebar — so the scroller must be a scrollable element that contains post links, else `window`. Timing comes from the `scrollDelay` / `maxEmptyScrolls` / `maxScrollTime` inputs; `requestHandlerTimeoutFor()` keeps the handler timeout above `maxScrollTime`. Logged-out users get a fixed ~15–20 posts followed by a "Log in for more" banner; scrolling stops early when it is detected. Logged-in pace is roughly 6 posts per ~14 s scroll step.

Video URLs are captured from network responses in a pre-navigation listener and handed to the page via `window.__threadsVideoRequests` before parsing.

## Schemas and inputs

- `.actor/input_schema.json` drives the Apify Console form. Note that some inputs accepted by the code are **not** in the schema: batch fields (`keywords`, `usernames`, `tags`, `postUrls`, `concurrency`) and `rateLimitConfig` (forwarded to every batch task). `outputFormat` exists in types but is unused. Keep the schema, `src/types.ts`, `.actor/dataset_schema.json` and both READMEs (`README.md`, `README.zh-TW.md`) in sync when adding or renaming fields.
- Default action is `profile` with `username: "zuck"` — Apify's automated Actor test runs with defaults, so defaults must produce a successful run without login.

## Testing notes

- `test/parser.integration.test.ts` loads inline HTML fixtures into real Chromium (`page.setContent`) and runs the parser. When fixing a parser bug, add or extend a fixture here instead of relying only on live smoke.
- `scripts/run-action-smoke.mjs` calls actions directly, stubbing `Dataset.pushData` and disabling proxy, and prints a JSON summary; `smoke-live.mjs` asserts on it (e.g. `@zuck` profile, a fixed post ID). These assertions depend on live data and may need updating if the content changes.

## Gotchas

- Playwright is pinned to `1.59.1` and must match the Docker base image tag `apify/actor-node-playwright-chrome:22-1.59.1` (the Dockerfile checks this). Upgrade both together; ask before changing the Dockerfile or installing packages.
- ESM with `NodeNext`: relative imports in `src/` must use the `.js` extension.
- Style: Prettier, 4 spaces, single quotes, print width 120.
- Threads changes its DOM often; prefer fixes in `selectors.ts`/`parser.ts` with fallbacks over action-specific hacks.
- `.actor/actor.json` → `meta.generatedBy` was deliberately set by the owner (commit `0a615b2`); do not overwrite it despite the instruction in `AGENTS.md`.
- Never commit `storageState` / cookies or anything under `storage/`.

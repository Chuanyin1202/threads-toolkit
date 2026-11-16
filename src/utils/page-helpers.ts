/**
 * Page helper utilities - shared across all actions
 *
 * Contains:
 * - Error detection (login wall, error page, empty page)
 * - Scroll utilities for infinite loading
 * - Post validation
 */

import type { Log } from 'crawlee';
import type { Page } from 'playwright';

import type { ProfileData, RateLimitConfig, ScrollConfig, ThreadsPost } from '../types.js';
import { extractPostsFromPage } from './parser.js';
import { SELECTORS } from './selectors.js';

const THREADS_VIDEO_REQUESTS_KEY = '__threadsVideoRequests';

// Default rate limit configuration
export const DEFAULT_RATE_LIMIT_CONFIG: Required<RateLimitConfig> = {
    requestDelay: 1000,
    maxRetries: 3,
    backoffDelay: 5000,
    backoffMultiplier: 2,
};

/**
 * Page error detection result
 */
export interface PageErrorInfo {
    isLoginWall: boolean;
    isErrorPage: boolean;
    isRateLimited: boolean;
    /** Threads explicitly shows an empty search result ("No results.") */
    isNoResults: boolean;
    isEmpty: boolean;
    hasMainContent: boolean;
    postLinkCount: number;
    errorMessage: string;
}

/**
 * Rate limit error class for specific handling
 */
export class RateLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RateLimitError';
    }
}

/**
 * Block heavy resources to save bandwidth/cost.
 * Currently blocks images/media/fonts; allows HTML/JS/CSS.
 */
export async function blockHeavyResources(page: Page): Promise<void> {
    // Block heavy resources to save bandwidth
    const blockedTypes = new Set(['image', 'font', 'media']);
    await page.route("**/*", async (route) => {
        const rt = route.request().resourceType();
        if (blockedTypes.has(rt)) {
            return route.abort();
        }
        return route.continue();
    });
}

/**
 * Enhanced error detection for page states
 * Detects login walls, error pages, rate limiting, and empty pages
 */
export async function detectPageError(page: Page): Promise<PageErrorInfo> {
    return page.evaluate(() => {
        const {body} = document;
        // innerText = visible text only. textContent would include inline <script> payloads,
        // which contain words like "blocked"/"unavailable" and caused false error detection.
        const bodyText = body?.innerText || '';
        const bodyTextLower = bodyText.toLowerCase();

        // Check for login wall by looking for login buttons with specific text
        const loginTexts = ['Log in', '登入', 'ログイン', '로그인'];
        const buttons = document.querySelectorAll('button, a[role="button"]');
        let isLoginWall = false;
        for (const btn of buttons) {
            const text = btn.textContent?.trim() || '';
            if (loginTexts.some((lt) => text.includes(lt))) {
                isLoginWall = true;
                break;
            }
        }
        // Also check for login dialog
        if (!isLoginWall) {
            const loginLink = document.querySelector('[role="dialog"] a[href*="login"]');
            isLoginWall = loginLink !== null;
        }

        // Check for rate limiting patterns
        const rateLimitPatterns = [
            'rate limit',
            'too many requests',
            'try again later',
            '請稍後再試',
            '请稍后再试',
            'しばらくしてからもう一度お試しください',
            '나중에 다시 시도',
            'slow down',
            'temporarily blocked',
            '暫時被封鎖',
            '暂时被封锁',
            'wait a few minutes',
            '請等待幾分鐘',
            '请等待几分钟',
        ];
        const isRateLimited = rateLimitPatterns.some((pattern) =>
            bodyTextLower.includes(pattern.toLowerCase())
        );

        // Explicit empty search result
        const noResultsPatterns = [
            'no results',
            'нет результатов',
            'ничего не найдено',
            '找不到結果',
            '沒有結果',
            '没有结果',
            '結果が見つかりません',
            '결과 없음',
        ];
        const isNoResults = noResultsPatterns.some((pattern) => bodyTextLower.includes(pattern));

        // Check for error messages in multiple languages
        const errorPatterns = [
            'Something went wrong',
            '出了點問題',
            '出了点问题',
            '問題が発生しました',
            '문제가 발생했습니다',
            'Try again',
            'blocked',
            'unavailable',
        ];
        const isErrorPage = errorPatterns.some((pattern) =>
            bodyTextLower.includes(pattern.toLowerCase())
        );

        // Check if main content area exists and has content
        const mainContent = document.querySelector('div[role="main"]');
        const hasMainContent = mainContent !== null && mainContent.children.length > 0;

        const postLinkCount = document.querySelectorAll('a[href*="/post/"]').length;

        // Check if page is essentially empty: no post links and very little content
        const isEmpty = postLinkCount === 0 && (!hasMainContent || bodyText.trim().length < 50);

        // Extract error message if present
        let errorMessage = 'Unknown error';
        if (isRateLimited) {
            errorMessage = 'Rate limited by Threads';
        } else {
            for (const pattern of errorPatterns) {
                if (bodyTextLower.includes(pattern.toLowerCase())) {
                    errorMessage = pattern;
                    break;
                }
            }
        }

        return {
            isLoginWall,
            isErrorPage,
            isRateLimited,
            isNoResults,
            isEmpty,
            hasMainContent,
            postLinkCount,
            errorMessage,
        };
    });
}

/**
 * Scroll page to load more posts and return every post parsed along the way
 *
 * Uses cumulative ID tracking to handle Threads' dynamic DOM where
 * old posts get unloaded as new ones load (virtual scrolling).
 * Note: Threads limits content for non-logged-in users (~10 for search, ~20 for profile).
 */
export const DEFAULT_SCROLL_CONFIG: Required<ScrollConfig> = {
    scrollDelay: 2000,
    maxEmptyScrolls: 4,
    maxScrollTime: 45,
};

/**
 * Request handler timeout that leaves room for the configured scroll time
 * (page load + error checks + parsing on top of scrolling).
 */
export function requestHandlerTimeoutFor(scrollConfig: ScrollConfig): number {
    const scrollSecs = scrollConfig.maxScrollTime ?? DEFAULT_SCROLL_CONFIG.maxScrollTime;
    return Math.max(120, scrollSecs + 120);
}

export async function scrollForPosts(
    page: Page,
    maxItems: number,
    log: Log,
    scrollConfig: ScrollConfig = {},
): Promise<ThreadsPost[]> {
    const SCROLL_DELAY = Math.max(0, scrollConfig.scrollDelay ?? DEFAULT_SCROLL_CONFIG.scrollDelay);
    const MAX_NO_NEW_CONTENT = Math.max(1, scrollConfig.maxEmptyScrolls ?? DEFAULT_SCROLL_CONFIG.maxEmptyScrolls);
    const GLOBAL_TIMEOUT = Math.max(1, scrollConfig.maxScrollTime ?? DEFAULT_SCROLL_CONFIG.maxScrollTime) * 1000;
    // Dynamic limit based on maxItems to avoid wasting time (the time limit above is the hard cap)
    const maxAttempts = Math.ceil(maxItems / 5) + 5;
    let noNewContentCount = 0;
    let scrollCount = 0;
    const startTime = Date.now();

    // Track ALL seen post IDs across scrolls (cumulative)
    // This handles Threads' virtual scrolling where old posts get unloaded
    const seenPostIds = new Set<string>();

    // Parsed posts collected on every step. Threads unloads posts that scrolled far out of view,
    // so parsing only once at the end would lose everything but the last screen.
    const collected = new Map<string, ThreadsPost>();
    const collectVisiblePosts = async (): Promise<void> => {
        const visible = await extractPostsFromPage(page, Infinity, new Set(collected.keys())).catch(() => [] as ThreadsPost[]);
        for (const post of visible) {
            if (!collected.has(post.id)) collected.set(post.id, post);
        }
    };
    await collectVisiblePosts();
    const videoRequests = new Set<string>();

    // Intercept network responses to capture video URLs as fallback
    page.on('response', async (response) => {
        try {
            const ct = response.headers()['content-type'] || '';
            if (ct.startsWith('video/') || response.url().match(/\.(mp4|m3u8)(\?|$)/i)) {
                videoRequests.add(response.url());
            }
        } catch {
            /* ignore */
        }
    });

    for (let i = 0; i < maxAttempts && noNewContentCount < MAX_NO_NEW_CONTENT; i++) {
        // Check global timeout
        if (Date.now() - startTime > GLOBAL_TIMEOUT) {
            log.info('Scroll: timeout reached', { elapsed: Math.round((Date.now() - startTime) / 1000), total: seenPostIds.size });
            break;
        }

        scrollCount++;

        // Scroll in steps to trigger lazy loading (Threads uses virtual scrolling).
        // The feed lives in an inner scroll container (the document itself is not scrollable),
        // so scroll the largest scrollable element and fall back to the window.
        for (let step = 0; step < 3; step++) {
            await page.evaluate(() => {
                // Only containers that actually hold posts - a logged-in page also has a scrollable sidebar
                const scrollers = Array.from(document.querySelectorAll<HTMLElement>('div, main, section')).filter(
                    (el) =>
                        el.scrollHeight > el.clientHeight + 50 &&
                        /(auto|scroll)/.test(getComputedStyle(el).overflowY) &&
                        el.querySelector('a[href*="/post/"]') !== null,
                );
                scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
                const scroller = scrollers[0];
                if (scroller) {
                    scroller.scrollBy(0, scroller.clientHeight * 0.8);
                } else {
                    window.scrollBy(0, window.innerHeight * 0.8);
                }
            });
            await page.waitForTimeout(300);
        }

        // Wait for loading spinner to disappear (if visible)
        const spinner = page.locator(SELECTORS.common.spinner);
        if (await spinner.isVisible().catch(() => false)) {
            await spinner.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => undefined);
        }

        await page.waitForTimeout(SCROLL_DELAY);

        // Inject captured video URLs into page context for parser to read
        if (videoRequests.size > 0) {
            const urls = Array.from(videoRequests);
            await page.evaluate(({ captured, key }) => {
                try {
                    const pageWindow = window as unknown as Record<string, string[] | undefined>;
                    pageWindow[key] = captured;
                } catch {
                    /* ignore */
                }
            }, { captured: urls, key: THREADS_VIDEO_REQUESTS_KEY });
        }

        // Collect post IDs currently in DOM and add to cumulative set
        const currentIds = await page.$$eval(SELECTORS.post.postLink, (links) => {
            const ids: string[] = [];
            for (const link of links) {
                const href = link.getAttribute('href') || '';
                const match = href.match(/\/post\/([A-Za-z0-9_-]+)/);
                if (match) ids.push(match[1]);
            }
            return ids;
        });

        const previousSize = seenPostIds.size;
        currentIds.forEach((id) => seenPostIds.add(id));
        await collectVisiblePosts();

        if (seenPostIds.size === previousSize) {
            noNewContentCount++;
            log.info('Scroll: no new posts', { attempt: i + 1, noNewCount: noNewContentCount, total: seenPostIds.size });

            // Logged-out users get a fixed set of posts followed by a "Log in for more" banner.
            // Waiting longer won't load anything, so stop and say why.
            if (await isLoginForMoreShown(page)) {
                log.warning('Threads shows "Log in for more" - no more posts without login. Use useCookies + storageState to get more.', {
                    total: seenPostIds.size,
                });
                break;
            }
        } else {
            noNewContentCount = 0;
            log.info('Scroll: found posts', { attempt: i + 1, newPosts: seenPostIds.size - previousSize, total: seenPostIds.size });
        }

        // Stop early if we have enough posts
        if (collected.size >= maxItems * 1.2) {
            log.info('Collected enough posts, stopping scroll', { posts: collected.size });
            break;
        }
    }

    log.info('Scroll complete', { totalSeen: seenPostIds.size, parsed: collected.size, scrollAttempts: scrollCount });
    return Array.from(collected.values());
}

/**
 * Detect the end-of-feed banner Threads shows to logged-out users
 * ("Log in for more threads about this topic.")
 */
async function isLoginForMoreShown(page: Page): Promise<boolean> {
    return page
        .evaluate(() => {
            const text = (document.body?.innerText || '').toLowerCase();
            return ['log in for more', 'log in to see more', 'войдите, чтобы', '登入以查看更多', '登录以查看更多'].some((p) => text.includes(p));
        })
        .catch(() => false);
}

/**
 * Validate post data before saving to Dataset
 * Returns validation result with reason if invalid
 */
export function validatePost(post: ThreadsPost): { valid: boolean; reason?: string } {
    if (!post.content || post.content.length < 3) {
        return { valid: false, reason: 'noContent' };
    }
    if (!post.author.username || post.author.username === 'unknown') {
        return { valid: false, reason: 'noAuthor' };
    }
    if (!post.timestamp) {
        return { valid: false, reason: 'noTimestamp' };
    }
    return { valid: true };
}

/**
 * Validate profile data
 * More lenient - only username is required
 */
export function validateProfile(profile: ProfileData): { valid: boolean; reason?: string; partial?: boolean; missing?: string[] } {
    const missing: string[] = [];

    if (!profile.username) {
        return { valid: false, reason: 'noUsername' };
    }
    if (!profile.displayName) missing.push('displayName');
    if (!profile.avatarUrl) missing.push('avatarUrl');
    if (profile.followersCount === undefined) missing.push('followersCount');
    if (!profile.bio) missing.push('bio');
    // Track location and joinedDate as optional fields
    if (profile.location === null || profile.location === undefined) missing.push('location');
    if (profile.joinedDate === null || profile.joinedDate === undefined) missing.push('joinedDate');

    return { valid: true, partial: missing.length > 0, missing };
}

/**
 * Handle page error and throw appropriate error message
 */
export function handlePageError(errorInfo: PageErrorInfo, _context: string): void {
    if (errorInfo.isRateLimited) {
        throw new RateLimitError('Rate limited: Threads is limiting requests. The crawler will retry with exponential backoff.');
    }

    if (errorInfo.isLoginWall) {
        throw new Error('Login required: Threads is showing a login wall. Try using a different proxy or reducing request frequency.');
    }

    if (errorInfo.isErrorPage) {
        throw new Error(`Threads returned an error: ${errorInfo.errorMessage}. The site may be rate limiting or blocking requests.`);
    }
}

/**
 * Sleep utility for delays
 */
export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * Execute a function with exponential backoff retry on rate limit errors
 */
export async function withRateLimitRetry<T>(
    fn: () => Promise<T>,
    config: RateLimitConfig,
    log: Log,
    context: string
): Promise<T> {
    const {
        maxRetries = DEFAULT_RATE_LIMIT_CONFIG.maxRetries,
        backoffDelay = DEFAULT_RATE_LIMIT_CONFIG.backoffDelay,
        backoffMultiplier = DEFAULT_RATE_LIMIT_CONFIG.backoffMultiplier,
    } = config;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error as Error;

            // Only retry on rate limit errors
            if (!(error instanceof RateLimitError)) {
                throw error;
            }

            if (attempt < maxRetries) {
                const delay = backoffDelay * backoffMultiplier**attempt;
                log.warning(`Rate limited (${context}), retrying in ${delay / 1000}s...`, {
                    attempt: attempt + 1,
                    maxRetries,
                    delayMs: delay,
                });
                await sleep(delay);
            }
        }
    }

    // All retries exhausted
    log.error(`Rate limit retries exhausted (${context})`, { maxRetries });
    throw lastError;
}

/**
 * Apply request delay between operations
 */
export async function applyRequestDelay(config: RateLimitConfig, log: Log): Promise<void> {
    const delay = config.requestDelay ?? DEFAULT_RATE_LIMIT_CONFIG.requestDelay;
    if (delay > 0) {
        log.debug(`Applying request delay: ${delay}ms`);
        await sleep(delay);
    }
}

/**
 * Check for 404/not found page
 */
export async function isNotFoundPage(page: Page): Promise<boolean> {
    const pageContent = await page.content();
    return pageContent.includes('找不到這個頁面') ||
           pageContent.includes('Page not found') ||
           pageContent.includes('ページが見つかりません') ||
           pageContent.includes('페이지를 찾을 수 없습니다');
}

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

import type { ProfileData, RateLimitConfig, ThreadsPost } from '../types.js';
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
        const bodyText = body?.textContent || '';
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
            isEmpty,
            hasMainContent,
            postLinkCount,
            errorMessage,
        };
    });
}

/**
 * Scroll page to load more posts
 *
 * Uses cumulative ID tracking to handle Threads' dynamic DOM where
 * old posts get unloaded as new ones load (virtual scrolling).
 * Note: Threads limits content for non-logged-in users (~10 for search, ~20 for profile).
 */
export async function scrollForPosts(
    page: Page,
    maxItems: number,
    log: Log
): Promise<void> {
    // Dynamic limit based on maxItems to avoid wasting time
    const maxAttempts = Math.min(20, Math.ceil(maxItems / 5) + 5);
    const MAX_NO_NEW_CONTENT = 4;
    const SCROLL_DELAY = 2000;
    const GLOBAL_TIMEOUT = 45000; // 45s max total scroll time
    let noNewContentCount = 0;
    let scrollCount = 0;
    const startTime = Date.now();

    // Track ALL seen post IDs across scrolls (cumulative)
    // This handles Threads' virtual scrolling where old posts get unloaded
    const seenPostIds = new Set<string>();
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

        // Scroll in steps to trigger lazy loading (Threads uses virtual scrolling)
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        for (let step = 0; step < 3; step++) {
            await page.evaluate((h) => window.scrollBy(0, h * 0.8), viewportHeight);
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

        if (seenPostIds.size === previousSize) {
            noNewContentCount++;
            log.info('Scroll: no new posts', { attempt: i + 1, noNewCount: noNewContentCount, total: seenPostIds.size });
        } else {
            noNewContentCount = 0;
            log.info('Scroll: found posts', { attempt: i + 1, newPosts: seenPostIds.size - previousSize, total: seenPostIds.size });
        }

        // Stop early if we have enough posts
        if (seenPostIds.size >= maxItems * 1.5) {
            log.info('Collected enough posts, stopping scroll', { posts: seenPostIds.size });
            break;
        }
    }

    log.info('Scroll complete', { totalSeen: seenPostIds.size, scrollAttempts: scrollCount });
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

/**
 * Post Action - Fetch single post details
 *
 * Uses centralized parsing from parser.ts for consistency.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, Log } from 'crawlee';
import type { PostInput } from '../types.js';
import {
    extractSinglePostFromPage,
    detectPageError,
    handlePageError,
    isNotFoundPage,
    validatePost,
    scrollForPosts,
    extractPostsFromPage,
    blockHeavyResources,
    DEFAULT_RATE_LIMIT_CONFIG,
    sleep,
} from '../utils/index.js';

/**
 * Execute post action
 */
export async function postAction(input: PostInput, log: Log): Promise<void> {
    const { postUrl, proxyConfiguration: proxyConfig, maxItems, useCookies = false, storageState, rateLimitConfig = {} } = input;
    const maxReplies = maxItems ?? 50;

    // Merge with defaults
    const rateLimitSettings = { ...DEFAULT_RATE_LIMIT_CONFIG, ...rateLimitConfig };

    // Determine if we should use cookies (only if enabled AND storageState provided)
    const useAuth = useCookies && storageState && Object.keys(storageState).length > 0;

    // Warn if useCookies enabled but no storageState provided
    if (useCookies && !useAuth) {
        log.warning('useCookies enabled but storageState is empty, falling back to no-auth mode');
    }

    log.info('Starting post fetch', { postUrl, useAuth });

    // Validate and normalize URL
    const normalizedUrl = normalizePostUrl(postUrl);
    if (!normalizedUrl) {
        throw new Error(`Invalid post URL: ${postUrl}`);
    }

    // Extract post ID from URL
    const postId = extractPostId(normalizedUrl);
    if (!postId) {
        throw new Error(`Could not extract post ID from URL: ${postUrl}`);
    }

    // Create proxy configuration from input
    const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

    // Shared set for capturing video URLs across hooks and handler
    const videoRequests = new Set<string>();

    // Create crawler with post-specific handler
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 1,
        maxConcurrency: 1,
        headless: true,
        requestHandlerTimeoutSecs: 120,
        navigationTimeoutSecs: 60,
        maxRequestRetries: rateLimitSettings.maxRetries, // Enable Crawlee retry on failures
        preNavigationHooks: [
            async ({ page, request }) => {
                // Set up blocking and listeners first (before any delays)
                await blockHeavyResources(page);
                // Intercept network responses to capture video URLs (before navigation)
                page.on('response', async (response) => {
                    try {
                        const ct = response.headers()['content-type'] || '';
                        const url = response.url();
                        if (ct.startsWith('video/') || url.match(/\.(mp4|m3u8)(\?|$)/i)) {
                            videoRequests.add(url);
                        }
                    } catch {
                        /* ignore */
                    }
                });

                // Apply delays after setup (so listeners catch all requests)
                if (rateLimitSettings.requestDelay > 0) {
                    log.debug(`Applying request delay: ${rateLimitSettings.requestDelay}ms`);
                    await sleep(rateLimitSettings.requestDelay);
                }

                // If this is a retry, apply exponential backoff
                if (request.retryCount > 0) {
                    const backoffDelay = rateLimitSettings.backoffDelay *
                        Math.pow(rateLimitSettings.backoffMultiplier, request.retryCount - 1);
                    log.warning(`Retry attempt ${request.retryCount}/${rateLimitSettings.maxRetries}, waiting ${backoffDelay / 1000}s...`);
                    await sleep(backoffDelay);
                }
            },
        ],
        launchContext: {
            launchOptions: {
                args: ['--disable-gpu', '--no-sandbox'],
            },
        },
        browserPoolOptions: {
            useFingerprints: false,
            postPageCreateHooks: useAuth ? [
                async (page) => {
                    const state = storageState as any;
                    // Inject cookies
                    const cookies = state?.cookies || [];
                    if (cookies.length > 0) {
                        await page.context().addCookies(cookies);
                        log.info('Injected login cookies', { count: cookies.length });
                    }
                    // Inject localStorage from origins (only for Threads domains)
                    const origins = state?.origins || [];
                    for (const origin of origins) {
                        const originUrl = origin.origin || '';
                        // Only inject for Threads domains
                        if (!originUrl.includes('threads.net') && !originUrl.includes('threads.com')) {
                            log.debug('Skipping non-Threads origin', { origin: originUrl });
                            continue;
                        }
                        const localStorage = origin.localStorage || [];
                        if (localStorage.length > 0) {
                            await page.context().addInitScript((items) => {
                                for (const item of items) {
                                    window.localStorage.setItem(item.name, item.value);
                                }
                            }, localStorage);
                            log.info('Injected localStorage', { origin: originUrl, count: localStorage.length });
                        }
                        // Note: sessionStorage is not injected (Playwright limitation)
                        const sessionStorage = origin.sessionStorage || [];
                        if (sessionStorage.length > 0) {
                            log.debug('sessionStorage not injected (not supported)', { origin: originUrl, count: sessionStorage.length });
                        }
                    }
                },
            ] : undefined,
        },
        requestHandler: async ({ page, request }) => {
            log.info('Processing post page', { url: request.url });

            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            log.debug('DOM content loaded');

            // Wait for post content to appear
            try {
                await page.waitForSelector('a[href*="/post/"]', { timeout: 15000 });
                log.info('Post content found');

                // Give time for video requests to be captured
                await page.waitForTimeout(2000);

                // Inject captured video URLs into page context
                if (videoRequests.size > 0) {
                    const urls = Array.from(videoRequests);
                    log.info('Captured video URLs from network', { count: urls.length });
                    await page.evaluate((captured) => {
                        (window as any).__threadsVideoRequests = captured;
                    }, urls);
                }
            } catch {
                // Check for error states using shared helper
                const errorInfo = await detectPageError(page);

                if (errorInfo.isLoginWall) {
                    handlePageError(errorInfo, 'post');
                }

                if (errorInfo.isErrorPage) {
                    handlePageError(errorInfo, 'post');
                }

                // Check for 404
                if (await isNotFoundPage(page)) {
                    throw new Error(`Post not found: ${postUrl}`);
                }

                throw new Error(`Failed to load post page: ${postUrl}`);
            }

            // Extract post data using centralized parser
            const postData = await extractSinglePostFromPage(page, postId, normalizedUrl);

            if (!postData) {
                throw new Error(`Failed to extract post data from: ${postUrl}`);
            }

            // Validate post data
            const validation = validatePost(postData);
            if (!validation.valid) {
                log.warning('Post data validation failed - skipping', { reason: validation.reason, id: postData.id });
                return;
            }

            // Push to dataset
            await Dataset.pushData(postData);
            log.info('Post data saved', { id: postData.id });

            // Fetch replies on the page (treat as posts with source=reply)
            try {
                await scrollForPosts(page, maxReplies, log);
                const replies = await extractPostsFromPage(page, maxReplies);
                for (const reply of replies) {
                    if (reply.id === postData.id) continue; // skip main post
                    await Dataset.pushData({ ...reply, source: 'reply', parentId: postData.id });
                }
                log.info('Replies saved', { count: replies.length, max: maxReplies });
            } catch (err) {
                log.warning('Failed to extract replies', { error: String(err) });
            }
        },
    });

    // Run crawler
    await crawler.run([{ url: normalizedUrl }]);

    log.info('Post action finished', { postUrl });
}

/**
 * Normalize post URL
 */
function normalizePostUrl(url: string): string | null {
    try {
        // Handle various URL formats
        if (url.includes('threads.net') || url.includes('threads.com')) {
            // Ensure it has the protocol
            if (!url.startsWith('http')) {
                url = 'https://' + url;
            }
            // Normalize domain to threads.com
            return url.replace('threads.net', 'threads.com');
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Extract post ID from URL
 */
function extractPostId(url: string): string | null {
    const match = url.match(/\/post\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}

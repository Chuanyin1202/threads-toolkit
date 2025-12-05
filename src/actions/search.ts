/**
 * Search Action - Search posts by keyword
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, Log } from 'crawlee';
import type { SearchInput, ThreadsPost } from '../types.js';
import {
    extractPostsFromPage,
    SELECTORS,
    detectPageError,
    scrollForPosts,
    validatePost,
    handlePageError,
    blockHeavyResources,
    RateLimitError,
    DEFAULT_RATE_LIMIT_CONFIG,
    sleep,
} from '../utils/index.js';

/**
 * Execute search action
 */
export async function searchAction(input: SearchInput, log: Log): Promise<void> {
    const {
        keyword,
        filter = 'recent',
        maxItems = 50,
        proxyConfiguration: proxyConfig,
        useCookies = false,
        storageState,
        rateLimitConfig = {},
    } = input;

    // Merge with defaults
    const rateLimitSettings = { ...DEFAULT_RATE_LIMIT_CONFIG, ...rateLimitConfig };

    // Determine if we should use cookies (only if enabled AND storageState provided)
    const useAuth = useCookies && storageState && Object.keys(storageState).length > 0;

    // Warn if useCookies enabled but no storageState provided
    if (useCookies && !useAuth) {
        log.warning('useCookies enabled but storageState is empty, falling back to no-auth mode');
    }

    log.info('Starting search', { keyword, filter, maxItems, useAuth });

    // Build search URL
    const searchUrl = buildSearchUrl(keyword, filter);
    const collectedPosts: ThreadsPost[] = [];
    const seenIds = new Set<string>();

    // Shared set for capturing video URLs across hooks and handler
    const videoRequests = new Set<string>();

    // Create proxy configuration from input
    const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

    // Create crawler with search-specific handler
    const crawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl: 1, // Single page for search
        maxConcurrency: 1, // Single browser for stability
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
            log.info('Processing search page', { url: request.url });

            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            log.debug('DOM content loaded');

            // Wait for post links to appear with enhanced error detection
            try {
                await page.waitForSelector(SELECTORS.post.postLink, { timeout: 15000 });
                log.info('Post links found');

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
                // Enhanced error detection
                const errorInfo = await detectPageError(page);

                // Check for rate limiting first
                if (errorInfo.isRateLimited) {
                    log.warning('Rate limited by Threads', { keyword });
                    throw new RateLimitError('Rate limited: Threads is limiting requests. Try again later or reduce request frequency.');
                }

                if (errorInfo.isLoginWall) {
                    throw new Error('Login required: Threads is showing a login wall. Try using a different proxy or reducing request frequency.');
                }

                if (errorInfo.isErrorPage) {
                    throw new Error(`Threads returned an error: ${errorInfo.errorMessage}. The site may be rate limiting or blocking requests.`);
                }

                if (errorInfo.isEmpty) {
                    // Page loaded but no posts - could be genuine empty result or blocking
                    log.warning('No posts found - page may be empty or blocked', {
                        keyword,
                        hasMainContent: errorInfo.hasMainContent,
                    });
                    return;
                }

                // Truly no results
                log.info('No posts found for this search query', { keyword });
                return;
            }

            // Scroll to load more posts
            await scrollForPosts(page, maxItems, log);

            // Extract posts using centralized parser
            const posts = await extractPostsFromPage(page, maxItems);
            log.info('Extracted posts from page', { count: posts.length });

            // Process and save posts with validation
            const skipReasons: Record<string, number> = {};
            for (const post of posts) {
                if (collectedPosts.length >= maxItems) break;
                if (seenIds.has(post.id)) continue;

                // Use shared validation
                const validation = validatePost(post);
                if (!validation.valid) {
                    skipReasons[validation.reason || 'unknown'] = (skipReasons[validation.reason || 'unknown'] || 0) + 1;
                    continue;
                }

                seenIds.add(post.id);
                collectedPosts.push(post);
                log.debug('Collected post', { id: post.id, total: collectedPosts.length });

                // Push to dataset immediately
                await Dataset.pushData(post);
            }

            const totalSkipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
            if (totalSkipped > 0) {
                log.info('Skipped low-quality posts', { total: totalSkipped, ...skipReasons });
            }

            log.info('Search completed', { collected: collectedPosts.length });
        },
    });

    // Run crawler
    await crawler.run([{ url: searchUrl }]);

    log.info('Search action finished', { totalPosts: collectedPosts.length });
}

/**
 * Build search URL
 */
function buildSearchUrl(keyword: string, filter: string): string {
    // Threads search URL structure
    const baseUrl = 'https://www.threads.com/search';

    // Build query params
    const params = new URLSearchParams({
        q: keyword,
        serp_type: 'default',
    });

    // Add filter if specified
    if (filter === 'top') {
        params.set('filter', 'top');
    }

    return `${baseUrl}?${params.toString()}`;
}

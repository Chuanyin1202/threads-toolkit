/**
 * Profile Action - Fetch user profile data
 *
 * Uses centralized parsing from parser.ts for consistency.
 */

import { Actor } from 'apify';
import { PlaywrightCrawler, Dataset, Log } from 'crawlee';
import type { ProfileInput } from '../types.js';
import {
    extractProfileFromPage,
    fetchProfileAbout,
    detectPageError,
    handlePageError,
    isNotFoundPage,
    validateProfile,
    validatePost,
    extractPostsFromPage,
    scrollForPosts,
    blockHeavyResources,
    DEFAULT_RATE_LIMIT_CONFIG,
    sleep,
} from '../utils/index.js';

/**
 * Execute profile action
 */
export async function profileAction(input: ProfileInput, log: Log): Promise<void> {
    const { username, proxyConfiguration: proxyConfig, maxItems = 20, includePosts = true, useCookies = false, storageState, rateLimitConfig = {} } = input;

    // Merge with defaults
    const rateLimitSettings = { ...DEFAULT_RATE_LIMIT_CONFIG, ...rateLimitConfig };

    // Determine if we should use cookies (only if enabled AND storageState provided)
    const useAuth = useCookies && storageState && Object.keys(storageState).length > 0;

    // Warn if useCookies enabled but no storageState provided
    if (useCookies && !useAuth) {
        log.warning('useCookies enabled but storageState is empty, falling back to no-auth mode');
    }

    log.info('Starting profile fetch', { username, useAuth });

    // Build profile URL
    const profileUrl = `https://www.threads.com/@${username}`;

    // Create proxy configuration from input
    const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);

    // Shared set for capturing video URLs across hooks and handler
    const videoRequests = new Set<string>();

    // Create crawler with profile-specific handler
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
            log.info('Processing profile page', { url: request.url });

            // Wait for page to load
            await page.waitForLoadState('domcontentloaded');
            log.debug('DOM content loaded');

            // Wait for profile content to appear
            try {
                // Wait for the profile header area with display name
                await page.waitForSelector('h1', { timeout: 15000 });
                log.info('Profile content found');
            } catch {
                // Check for error states using shared helper
                const errorInfo = await detectPageError(page);

                if (errorInfo.isLoginWall) {
                    handlePageError(errorInfo, 'profile');
                }

                if (errorInfo.isErrorPage) {
                    handlePageError(errorInfo, 'profile');
                }

                // Check for 404
                if (await isNotFoundPage(page)) {
                    throw new Error(`Profile not found: @${username}`);
                }

                throw new Error(`Failed to load profile page for @${username}`);
            }

            // Extract profile data using centralized parser
            const profileData = await extractProfileFromPage(page, username);

            if (!profileData) {
                throw new Error(`Failed to extract profile data for @${username}`);
            }

            // Fetch location and joined date via About dialog
            // Only available when authenticated (requires login to see "About this profile" option)
            if (useAuth) {
                try {
                    log.info('Fetching profile About data (authenticated mode)...');
                    const aboutResponse = await fetchProfileAbout(page);

                    if (aboutResponse.data) {
                        profileData.location = aboutResponse.data.location;
                        profileData.joinedDate = aboutResponse.data.joinedDate;
                        log.info('Profile About data extracted', {
                            location: aboutResponse.data.location,
                            joinedDate: aboutResponse.data.joinedDate,
                        });
                    } else {
                        log.debug('About data not available', { debug: aboutResponse.debug });
                        profileData.location = null;
                        profileData.joinedDate = null;
                    }
                } catch (err) {
                    log.warning('Failed to fetch profile About data', { error: String(err) });
                    profileData.location = null;
                    profileData.joinedDate = null;
                }
            } else {
                // Skip About extraction in non-authenticated mode
                log.debug('Skipping About data (requires authentication)');
                profileData.location = null;
                profileData.joinedDate = null;
            }

            // Validate profile data
            const validation = validateProfile(profileData);
            if (!validation.valid) {
                log.warning('Profile data validation failed', { reason: validation.reason });
                return;
            }
            if (validation.partial) {
                profileData.partial = true;
                profileData.missingFields = validation.missing;
                log.info('Profile data is partial', { missing: validation.missing });
            }

            // Push profile
            await Dataset.pushData({ ...profileData, type: 'profile', source: 'profile' });
            log.info('Profile data saved', { username: profileData.username });

            // Also fetch recent posts from profile page
            if (includePosts) {
                try {
                    // Inject captured video URLs into page context before extracting posts
                    if (videoRequests.size > 0) {
                        const urls = Array.from(videoRequests);
                        log.info('Captured video URLs from network', { count: urls.length });
                        await page.evaluate((captured) => {
                            (window as any).__threadsVideoRequests = captured;
                        }, urls);
                    }

                    await scrollForPosts(page, maxItems, log);
                    const posts = await extractPostsFromPage(page, maxItems);
                    let savedCount = 0;
                    for (const post of posts) {
                        const postValidation = validatePost(post);
                        if (!postValidation.valid) {
                            log.debug('Skipping invalid profile post', { reason: postValidation.reason, id: post.id });
                            continue;
                        }
                        await Dataset.pushData({ ...post, source: 'profile_posts', profile: profileData.username });
                        savedCount++;
                    }
                    log.info('Profile posts saved', { count: savedCount, total: posts.length, max: maxItems });
                } catch (err) {
                    log.warning('Failed to extract profile posts', { error: String(err) });
                }
            }
        },
    });

    // Run crawler
    await crawler.run([{ url: profileUrl }]);

    log.info('Profile action finished', { username });
}

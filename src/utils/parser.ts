/**
 * Data parsing utilities
 *
 * All DOM parsing logic is centralized here for easy maintenance.
 * This includes:
 * - Post parsing (search results, single post)
 * - Profile parsing
 * - Time/number parsing utilities
 */

import type { Page, Locator } from 'playwright';
import type { ThreadsPost, Author, PostStats, ProfileData } from '../types.js';
import { SELECTORS } from './selectors.js';

/**
 * Extract all posts from a page
 * This is the main entry point for search results parsing.
 * All DOM parsing logic is contained here for centralized maintenance.
 *
 * Strategy: Find all post links first, then for each unique post,
 * locate its container and parse it. This avoids issues with nested
 * containers where :has() might select outer wrappers.
 */
export async function extractPostsFromPage(page: Page, maxItems = Infinity): Promise<ThreadsPost[]> {
    const posts: ThreadsPost[] = [];
    const seenIds = new Set<string>();

    // Find all post links and extract unique post IDs
    const postLinks = page.locator(SELECTORS.post.postLink);
    const linkCount = await postLinks.count();

    for (let i = 0; i < linkCount; i++) {
        if (posts.length >= maxItems) break;

        const link = postLinks.nth(i);
        const href = await link.getAttribute('href').catch(() => null);
        if (!href) continue;

        // Extract post ID from URL
        const match = href.match(/\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
        if (!match) continue;

        const postId = match[2];
        if (seenIds.has(postId)) continue;
        seenIds.add(postId);

        // Find the post container by walking up from the link
        // Use evaluateHandle to get the container element, then wrap it
        const containerHandle = await link.evaluateHandle((linkEl) => {
            let current = linkEl.parentElement;
            let depth = 0;
            const MAX_DEPTH = 15;

            while (current && depth < MAX_DEPTH) {
                // Look for stats buttons to identify the post container
                const roleButtons = current.querySelectorAll('div[role="button"]');
                let statsCount = 0;

                for (const btn of roleButtons) {
                    const text = btn.textContent || '';
                    if (
                        text.includes('讚') ||
                        text.includes('留言') ||
                        text.includes('轉發') ||
                        /^Like/i.test(text) ||
                        /^Comment/i.test(text) ||
                        /^Repost/i.test(text)
                    ) {
                        statsCount++;
                    }
                }

                if (statsCount >= 2) {
                    return current;
                }

                current = current.parentElement;
                depth++;
            }

            return null;
        });

        const element = containerHandle.asElement();
        if (!element) continue;

        // Parse the container using parsePostFromElement
        const parsed = await parsePostFromElement(element, page, postId);
        if (!parsed) continue;

        posts.push(parsed);
    }

    return posts;
}

/**
 * Parse a post from an ElementHandle
 * Used when we have a direct reference to the container element
 */
async function parsePostFromElement(
    element: import('playwright').ElementHandle,
    _page: Page,
    postId: string
): Promise<ThreadsPost | null> {
    try {
        // Extract data directly from the element
        const data = await element.evaluate((node, id) => {
            const container = node as Element;
            // Get post URL
            const postLink = container.querySelector('a[href*="/post/"]');
            const href = postLink?.getAttribute('href') || '';
            const urlMatch = href.match(/\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
            const username = urlMatch?.[1] || 'unknown';

            // Get display name
            const usernameLink = container.querySelector(`a[href="/@${username}"]`);
            const displayName = usernameLink?.textContent?.trim() || username;

            // Get avatar
            const avatarImg = container.querySelector('img[alt*="大頭貼"], img[alt*="profile"], img[alt*="avatar"]');
            const avatarUrl = avatarImg?.getAttribute('src') || undefined;

            // Check if verified
            const verifiedBadge = container.querySelector('svg[aria-label*="已驗證"], svg[aria-label*="Verified"], img[alt*="已驗證"], img[alt*="Verified"]');
            const isVerified = verifiedBadge !== null;

            // Get content - collect all meaningful text (skip metadata/errors)
            const texts: string[] = [];
            const textElements = container.querySelectorAll('div[dir="auto"], span[dir="auto"]');
            for (const el of textElements) {
                if (el.closest('[role="button"]') || el.closest('a')) continue;
                const text = el.textContent?.trim() || '';
                if (
                    text.length > 5 &&
                    text !== username &&
                    text !== displayName &&
                    !text.match(/^\d+[小時分鐘秒天週月年]?前?$/) &&
                    !text.match(/^\d+[mhd]$/) &&
                    !text.match(/^[\d,]+$/) &&
                    !text.match(/^\d{1,4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,4}$/) &&
                    !text.match(/^(讚|留言|轉發|分享|翻譯|Like|Comment|Repost|Share|Translate)/i) &&
                    !text.toLowerCase().includes("trouble playing this video")
                ) {
                    texts.push(text);
                }
            }
            // Join texts and clean up trailing UI button texts
            let content = texts.length > 0 ? texts.join('\n\n') : '';
            // Remove trailing "Learn more", "Translate", "翻譯" etc.
            content = content
                .replace(/\s*(Learn more|了解更多)\s*$/i, '')
                .replace(/\s*(Translate|翻譯)\s*$/i, '')
                .trim();

            // Get timestamp
            const timeEl = container.querySelector('time');
            const timestamp = timeEl?.getAttribute('datetime') || timeEl?.textContent || '';

            // Quoted post - must exclude the main post's own links
            let quoted: {
                url?: string;
                content?: string;
                username?: string;
            } | undefined;
            const allPostLinks = container.querySelectorAll('a[href*="/post/"]');
            for (const link of allPostLinks) {
                const qHref = link.getAttribute('href') || '';
                const qMatch = qHref.match(/\/@([^/]+)\/post\/([A-Za-z0-9_-]+)/);
                if (!qMatch) continue;

                // Skip the main post's own link
                if (qMatch[2] === id) continue;

                // Found a different post link - this is a quoted post
                const quotedContainer = link.parentElement?.parentElement;
                let quotedContent = '';
                if (quotedContainer) {
                    const textEls = quotedContainer.querySelectorAll('div[dir="auto"]');
                    for (const el of textEls) {
                        const text = el.textContent?.trim() || '';
                        // Filter out timestamp formats
                        if (text.length > 5 &&
                            !text.match(/^\d+[mhd]$/) &&
                            !text.match(/^\d+\/\d+\/\d+$/)) {
                            quotedContent = text;
                            break;
                        }
                    }
                }

                quoted = {
                    url: qHref.startsWith('http') ? qHref : `https://www.threads.com${qHref}`,
                    username: qMatch[1],
                    content: quotedContent || undefined,
                };
                break; // Only take the first quoted post
            }

            // Get external links (non-Threads)
            const links: string[] = [];
            const anchorElements = container.querySelectorAll('a[href^="http"]');
            for (const a of anchorElements) {
                const href = a.getAttribute('href') || '';
                if (href && !href.includes('threads.com')) {
                    links.push(href);
                }
            }

            // Get stats - inline parsing to avoid esbuild __name helper issue
            let likes = 0, replies = 0, reposts = 0, shares = 0;
            const roleButtons = container.querySelectorAll('div[role="button"]');
            for (const btn of roleButtons) {
                const text = btn.textContent || '';
                // Inline number parsing
                const numMatch = text.match(/[\d,.]+[KkMm]?/);
                let num = 0;
                if (numMatch) {
                    const numStr = numMatch[0].replace(/,/g, '');
                    if (/[Kk]$/.test(numStr)) {
                        num = Math.round(parseFloat(numStr.slice(0, -1)) * 1000);
                    } else if (/[Mm]$/.test(numStr)) {
                        num = Math.round(parseFloat(numStr.slice(0, -1)) * 1000000);
                    } else {
                        num = parseInt(numStr, 10) || 0;
                    }
                }
                if (text.includes('讚') || /like/i.test(text)) likes = num;
                else if (text.includes('留言') || text.includes('回覆') || /comment|reply/i.test(text)) replies = num;
                else if (text.includes('轉發') || /repost/i.test(text)) reposts = num;
                else if (text.includes('分享') || /share/i.test(text)) shares = num;
            }

            // Get images (exclude avatars)
            const images: string[] = [];
            const imgElements = container.querySelectorAll('img');
            for (const img of imgElements) {
                const src = img.getAttribute('src');
                const alt = img.getAttribute('alt') || '';
                if (src && !src.includes('profile') && !alt.includes('大頭貼') && !alt.includes('profile') && !alt.includes('avatar')) {
                    images.push(src);
                }
            }

            // Get videos
            const videos: string[] = [];

            // DOM-based capture
            const videoElements = container.querySelectorAll('video source, video');
            for (const v of videoElements) {
                const src = v.getAttribute('src');
                if (src) videos.push(src);
            }

            // Network-based capture (fallback): scan for video URLs in network logs injected into the page
            // We look for a data attribute that might be injected by the crawler when intercepting requests.
            // If not present, this block is a no-op.
            try {
                const netVideos = (window as any).__threadsVideoRequests as string[] | undefined;
                if (netVideos && Array.isArray(netVideos)) {
                    for (const url of netVideos) {
                        if (!videos.includes(url)) videos.push(url);
                    }
                }
            } catch (e) {
                /* ignore */
            }

            return {
                id,
                username,
                displayName,
                avatarUrl,
                isVerified,
                content: content ? content.slice(0, 2000) : '',
                timestamp,
                likes,
                replies,
                reposts,
                shares,
                images,
                videos,
                links,
                quoted,
                url: `https://www.threads.com${href}`,
            };
        }, postId);

        return {
            id: data.id,
            url: data.url,
            author: {
                username: data.username,
                displayName: data.displayName || data.username,
                profileUrl: `https://www.threads.com/@${data.username}`,
                avatarUrl: data.avatarUrl,
                isVerified: data.isVerified,
            },
            content: data.content,
            timestamp: normalizeTimestamp(data.timestamp),
            stats: {
                likes: data.likes || 0,
                replies: data.replies || 0,
                reposts: data.reposts || 0,
                shares: data.shares || 0,
            },
            images: data.images.length > 0 ? data.images : undefined,
            videos: data.videos && data.videos.length > 0 ? data.videos : undefined,
            links: data.links && data.links.length > 0 ? data.links : undefined,
            quotedPost: data.quoted
                ? {
                      id: data.quoted.url?.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1] || `quoted_${Date.now()}`,
                      url: data.quoted.url || '',
                      author: data.quoted.username
                          ? {
                                username: data.quoted.username,
                                displayName: data.quoted.username,
                                profileUrl: `https://www.threads.com/@${data.quoted.username}`,
                            }
                          : {
                                username: 'unknown',
                                displayName: 'unknown',
                                profileUrl: '',
                            },
                      content: data.quoted.content || '',
                      timestamp: '',
                      stats: { likes: 0, replies: 0, reposts: 0, shares: 0 },
                  }
                : undefined,
        };
    } catch {
        return null;
    }
}

/**
 * Normalize timestamp to ISO format
 * Returns empty string if timestamp cannot be parsed (caller should handle)
 */
function normalizeTimestamp(timestamp: string): string {
    if (!timestamp) return '';
    if (timestamp.match(/^\d{4}-\d{2}-\d{2}/)) return timestamp;
    return parseRelativeTime(timestamp);
}

/**
 * Parse a single post element
 */
export async function parsePost(
    postElement: Locator,
    _page: Page
): Promise<ThreadsPost | null> {
    try {
        // Get post URL
        const linkElement = postElement.locator('a[href*="/post/"]').first();
        const postUrl = await linkElement.getAttribute('href').catch(() => null);
        if (!postUrl) return null;

        const fullUrl = postUrl.startsWith('http')
            ? postUrl
            : `https://www.threads.com${postUrl}`;

        // Extract post ID from URL
        const idMatch = postUrl.match(/\/post\/([A-Za-z0-9_-]+)/);
        const id = idMatch ? idMatch[1] : `post_${Date.now()}`;

        // Parse author
        const author = await parseAuthor(postElement);

        // Parse content
        const content = await parseContent(postElement);

        // Parse timestamp
        const timestamp = await parseTimestamp(postElement);

        // Parse stats
        const stats = await parseStats(postElement);

        // Parse media
        const images = await parseImages(postElement);
        const links = await parseLinks(postElement);

        return {
            id,
            url: fullUrl,
            author,
            content,
            timestamp,
            stats,
            images: images.length > 0 ? images : undefined,
            links: links.length > 0 ? links : undefined,
        };
    } catch (error) {
        return null;
    }
}

/**
 * Parse author information
 */
async function parseAuthor(postElement: Locator): Promise<Author> {
    const usernameLink = postElement.locator(SELECTORS.post.author.username).first();
    const usernameHref = await usernameLink.getAttribute('href').catch(() => '');
    const username = usernameHref?.replace('/@', '').split('/')[0] || 'unknown';

    const displayNameEl = postElement.locator(SELECTORS.post.author.name).first();
    const displayName = await displayNameEl.textContent().catch(() => username);

    const avatarEl = postElement.locator(SELECTORS.post.author.avatar).first();
    const avatarUrl = await avatarEl.getAttribute('src').catch(() => undefined);

    const isVerified = await postElement
        .locator(SELECTORS.post.author.verified)
        .isVisible()
        .catch(() => false);

    return {
        username,
        displayName: displayName || username,
        profileUrl: `https://www.threads.com/@${username}`,
        avatarUrl: avatarUrl || undefined,
        isVerified,
    };
}

/**
 * Parse post content
 */
async function parseContent(postElement: Locator): Promise<string> {
    const contentElements = postElement.locator(SELECTORS.post.content);
    const texts: string[] = [];

    const count = await contentElements.count();
    for (let i = 0; i < Math.min(count, 5); i++) {
        const text = await contentElements.nth(i).textContent().catch(() => '');
        if (text && text.length > 10) {
            texts.push(text.trim());
        }
    }

    // Return the longest text (most likely the post content)
    // Clean up trailing UI button texts
    let content = texts.sort((a, b) => b.length - a.length)[0] || '';
    return content
        .replace(/\s*(Learn more|了解更多)\s*$/i, '')
        .replace(/\s*(Translate|翻譯)\s*$/i, '')
        .trim();
}

/**
 * Parse timestamp
 */
async function parseTimestamp(postElement: Locator): Promise<string> {
    const timeEl = postElement.locator(SELECTORS.post.timestamp).first();
    const datetime = await timeEl.getAttribute('datetime').catch(() => null);

    if (datetime) {
        return datetime;
    }

    // Fallback: parse relative time text
    const timeText = await timeEl.textContent().catch(() => '');
    return parseRelativeTime(timeText || '');
}

/**
 * Convert relative time to ISO string
 * Returns empty string if format is unrecognized (caller should handle)
 */
function parseRelativeTime(text: string): string {
    const now = new Date();
    const lowerText = text.toLowerCase().trim();

    // Empty input - cannot parse
    if (!lowerText) {
        return '';
    }

    // "Just now" patterns
    if (lowerText.includes('just now') || lowerText.includes('now') || lowerText.includes('剛剛')) {
        return now.toISOString();
    }

    // English style: 5m / 2h / 3d / 1w
    const enMatch = lowerText.match(/(\d+)\s*(s|m|h|d|w)/i);
    if (enMatch) {
        const value = parseInt(enMatch[1], 10);
        const unit = enMatch[2].toLowerCase();

        switch (unit) {
            case 's':
                now.setSeconds(now.getSeconds() - value);
                break;
            case 'm':
                now.setMinutes(now.getMinutes() - value);
                break;
            case 'h':
                now.setHours(now.getHours() - value);
                break;
            case 'd':
                now.setDate(now.getDate() - value);
                break;
            case 'w':
                now.setDate(now.getDate() - value * 7);
                break;
        }
        return now.toISOString();
    }

    // Chinese / CJK style: 5秒 / 5秒前 / 3分鐘 / 2小時 / 1天 / 1週 / 2月
    const zhMatch = text.match(/(\d+)\s*(秒鐘?|秒|分鐘?|分|小時|小时|時|天|日|週|周|星期|礼拜|月)\s*前?/);
    if (zhMatch) {
        const value = parseInt(zhMatch[1], 10);
        const unit = zhMatch[2];

        if (/秒/.test(unit)) {
            now.setSeconds(now.getSeconds() - value);
        } else if (/分/.test(unit)) {
            now.setMinutes(now.getMinutes() - value);
        } else if (/小時|小时|時/.test(unit)) {
            now.setHours(now.getHours() - value);
        } else if (/天|日/.test(unit)) {
            now.setDate(now.getDate() - value);
        } else if (/週|周|星期|礼拜/.test(unit)) {
            now.setDate(now.getDate() - value * 7);
        } else if (/月/.test(unit)) {
            // Approximate months as 30 days
            now.setDate(now.getDate() - value * 30);
        }
        return now.toISOString();
    }

    // Unrecognized format - return empty to signal parsing failure
    return '';
}

/**
 * Parse engagement stats
 * Button text format: "讚 2,049" or "Like 2,049" or just "讚" (no count)
 */
async function parseStats(postElement: Locator): Promise<PostStats> {
    const parseCount = async (selector: string): Promise<number> => {
        try {
            const el = postElement.locator(selector).first();
            const isVisible = await el.isVisible().catch(() => false);
            if (!isVisible) return 0;

            const text = await el.textContent().catch(() => '0');
            return parseStatNumber(text || '0');
        } catch {
            return 0;
        }
    };

    return {
        likes: await parseCount(SELECTORS.post.stats.likes),
        replies: await parseCount(SELECTORS.post.stats.replies),
        reposts: await parseCount(SELECTORS.post.stats.reposts),
        shares: await parseCount(SELECTORS.post.stats.shares),
    };
}

/**
 * Parse stat number (handles K, M suffixes and comma separators)
 * Examples: "讚 2,049" -> 2049, "1.5K" -> 1500, "2M" -> 2000000
 */
function parseStatNumber(text: string): number {
    // Remove all non-numeric characters except . K M and commas
    // First, extract any number-like patterns from the text
    const numberMatch = text.match(/[\d,]+\.?\d*[KkMm]?/);
    if (!numberMatch) return 0;

    const numStr = numberMatch[0];
    // Remove commas
    const cleaned = numStr.replace(/,/g, '');

    if (cleaned.match(/[Kk]/)) {
        return Math.round(parseFloat(cleaned.replace(/[Kk]/g, '')) * 1000);
    }
    if (cleaned.match(/[Mm]/)) {
        return Math.round(parseFloat(cleaned.replace(/[Mm]/g, '')) * 1000000);
    }

    return parseInt(cleaned, 10) || 0;
}

/**
 * Parse images
 */
async function parseImages(postElement: Locator): Promise<string[]> {
    const images: string[] = [];
    const imgElements = postElement.locator(SELECTORS.post.images);
    const count = await imgElements.count();

    for (let i = 0; i < count; i++) {
        const img = imgElements.nth(i);
        const src = await img.getAttribute('src').catch(() => null);
        const alt = (await img.getAttribute('alt').catch(() => '')) || '';
        if (
            src &&
            !src.includes('profile') &&
            !alt.includes('profile') &&
            !alt.includes('avatar') &&
            !alt.includes('大頭貼')
        ) {
            images.push(src);
        }
    }

    return images;
}

/**
 * Parse external links (non-Threads)
 */
async function parseLinks(postElement: Locator): Promise<string[]> {
    const links: string[] = [];
    const anchorElements = postElement.locator('a[href^="http"]');
    const count = await anchorElements.count();
    for (let i = 0; i < count; i++) {
        const href = await anchorElements.nth(i).getAttribute('href').catch(() => null);
        if (href && !href.includes('threads.com')) {
            links.push(href);
        }
    }
    return links;
}

// ============================================
// Profile Parsing
// ============================================

/**
 * Extract profile data from a profile page
 * Returns null on failure, with optional fields as undefined
 */
export async function extractProfileFromPage(page: Page, username: string): Promise<ProfileData | null> {
    try {
        const data = await page.evaluate((inputUsername) => {
            // Find the profile region
            const profileRegion = document.querySelector('[role="region"]') || document.body;

            // Get display name - first h1 that contains actual name (not username)
            const h1Elements = profileRegion.querySelectorAll('h1');
            let displayName = inputUsername;
            for (const h1 of h1Elements) {
                const text = h1.textContent?.trim() || '';
                // Skip if it's the username (without @) or starts with @
                if (text && text !== inputUsername && !text.startsWith('@') && text !== `@${inputUsername}`) {
                    displayName = text;
                    break;
                }
            }

            // Get avatar URL
            const avatarImg = profileRegion.querySelector('img[alt*="大頭貼"], img[alt*="profile picture"], img[alt*="avatar"]');
            const avatarUrl = avatarImg?.getAttribute('src') || undefined;

            // Check if verified - search entire document for badge
            const verifiedBadge = document.querySelector('img[alt*="已驗證"], img[alt*="Verified"], svg[aria-label*="已驗證"], svg[aria-label*="Verified"]');
            const isVerified = verifiedBadge !== null;

            // Get bio - look for text content in the profile header area
            let bio: string | undefined;
            const textElements = profileRegion.querySelectorAll('div[dir="auto"], span[dir="auto"]');
            for (const el of textElements) {
                // Skip if inside a button or link
                if (el.closest('button') || el.closest('a')) continue;
                const text = el.textContent?.trim() || '';
                // Skip username, display name, and short/metadata texts
                if (text.length > 10 &&
                    text !== inputUsername &&
                    text !== displayName &&
                    !text.includes('位粉絲') &&
                    !text.includes('followers') &&
                    !text.includes('登入') &&
                    !text.includes('Log in')) {
                    bio = text;
                    break;
                }
            }

            // Get followers count - gracefully handle missing data
            let followersCount: number | undefined;
            const followersLink = profileRegion.querySelector('a[href*="followers"], a[href*="login"]');
            if (followersLink) {
                const followersText = followersLink.textContent || '';
                // Parse various formats: "541.7 萬位粉絲", "1,234 followers", "5.4M followers"
                const match = followersText.match(/([\d,.]+)\s*(萬|万|[KkMm])?/);
                if (match) {
                    let num = parseFloat(match[1].replace(/,/g, ''));
                    const unit = match[2];
                    if (unit === '萬' || unit === '万') {
                        num *= 10000;
                    } else if (unit === 'K' || unit === 'k') {
                        num *= 1000;
                    } else if (unit === 'M' || unit === 'm') {
                        num *= 1000000;
                    }
                    followersCount = Math.round(num);
                }
            }

            return {
                username: inputUsername,
                displayName,
                avatarUrl,
                isVerified,
                bio,
                followersCount,
            };
        }, username);

        return {
            username: data.username,
            displayName: data.displayName,
            profileUrl: `https://www.threads.com/@${data.username}`,
            avatarUrl: data.avatarUrl,
            bio: data.bio,
            isVerified: data.isVerified,
            followersCount: data.followersCount,
        };
    } catch {
        return null;
    }
}

// ============================================
// Single Post Parsing
// ============================================

/**
 * Extract a single post from its dedicated page
 * Reuses the same DOM parsing logic as search results
 */
export async function extractSinglePostFromPage(page: Page, postId: string, postUrl: string): Promise<ThreadsPost | null> {
    // Use any post link on the page - the first one should be the main post
    // This is more reliable than searching for specific postId which may differ in format
    const postLinks = page.locator('a[href*="/post/"]');
    const count = await postLinks.count();
    if (count === 0) return null;

    // Get the first post link
    const firstLink = postLinks.first();
    const linkHandle = await firstLink.elementHandle({ timeout: 5000 }).catch(() => null);
    if (!linkHandle) return null;

    // Walk up to find the container with stats buttons (reuse search logic)
    const containerHandle = await linkHandle.evaluateHandle((linkEl) => {
        let current = linkEl.parentElement;
        let depth = 0;
        const MAX_DEPTH = 15;

        while (current && depth < MAX_DEPTH) {
            const roleButtons = current.querySelectorAll('div[role="button"]');
            let statsCount = 0;
            for (const btn of roleButtons) {
                const text = btn.textContent || '';
                if (
                    text.includes('讚') ||
                    text.includes('留言') ||
                    text.includes('轉發') ||
                    /^Like/i.test(text) ||
                    /^Comment/i.test(text) ||
                    /^Repost/i.test(text)
                ) {
                    statsCount++;
                }
            }
            if (statsCount >= 2) {
                return current;
            }
            current = current.parentElement;
            depth++;
        }
        return null;
    });

    const element = containerHandle.asElement();
        if (!element) return null;

    const parsed = await parsePostFromElement(element, page, postId);
    if (!parsed) return null;

    // Override URL with normalized input to avoid href discrepancies
    return {
        ...parsed,
        url: postUrl,
    };
}

// ============================================
// Profile About API Functions
// ============================================

/**
 * Profile "About" data from API
 */
export interface ProfileAboutData {
    location: string | null;
    joinedDate: string | null;
}

/**
 * Extended response from fetchProfileAbout for debugging
 */
export interface ProfileAboutResponse {
    data: ProfileAboutData | null;
    debug?: {
        status?: number;
        error?: string;
    };
}

/**
 * Fetch profile "About" data by clicking the menu and reading the dialog content
 * This triggers the native UI and extracts data from the rendered dialog
 * Note: Requires authentication (useCookies + storageState) to work
 */
export async function fetchProfileAbout(page: Page): Promise<ProfileAboutResponse> {
    try {
        // Find the profile-specific More button (before Follow/Following button)
        const profileMoreButton = await page.evaluate(() => {
            const buttons = document.querySelectorAll('div[role="button"]');
            let lastMoreIndex = -1;

            for (let i = 0; i < buttons.length; i++) {
                const btn = buttons[i];
                const text = btn.textContent?.trim() || '';
                const svg = btn.querySelector('svg');
                const ariaLabel = svg?.getAttribute('aria-label') || '';

                if (ariaLabel === 'More' && text === 'More') {
                    lastMoreIndex = i;
                }

                // Also check for "Following" (已追蹤) in case user already follows this profile
                if (text === 'Follow' || text === '追蹤' || text === 'Following' || text === '正在追蹤') {
                    if (lastMoreIndex >= 0) {
                        return lastMoreIndex;
                    }
                }
            }
            return -1;
        });

        let menuClicked = false;

        if (profileMoreButton >= 0) {
            const allButtons = page.locator('div[role="button"]');
            await allButtons.nth(profileMoreButton).click();
            await page.waitForTimeout(800);
            menuClicked = true;
        } else {
            // Fallback: Try second More button
            const moreButtons = page.locator('div[role="button"]:has(svg[aria-label="More"])');
            const count = await moreButtons.count();
            if (count > 1) {
                await moreButtons.nth(1).click();
                await page.waitForTimeout(800);
                menuClicked = true;
            }
        }

        if (!menuClicked) {
            return {
                data: null,
                debug: { error: 'Profile menu button not found on page' },
            };
        }

        // Look for "About this profile" option
        const aboutSelectors = [
            'div[role="button"]:has-text("關於此個人檔案")',
            'div[role="button"]:has-text("About this profile")',
            'text="關於此個人檔案"',
            'text="About this profile"',
        ];

        let aboutClicked = false;
        for (const selector of aboutSelectors) {
            const aboutOption = page.locator(selector).first();
            const aboutVisible = await aboutOption.isVisible().catch(() => false);

            if (aboutVisible) {
                await aboutOption.click();
                await page.waitForTimeout(2000);
                aboutClicked = true;
                break;
            }
        }

        if (!aboutClicked) {
            await page.keyboard.press('Escape');
            return {
                data: null,
                debug: { error: 'About option not found. Enable useCookies and provide storageState to access this feature.' },
            };
        }

        // Wait for and extract data from the About dialog
        await page.waitForTimeout(2000);

        const aboutData = await page.evaluate(() => {
            // Look for the About dialog
            const dialogs = document.querySelectorAll('[role="dialog"]');
            let joinedDate: string | null = null;
            let location: string | null = null;

            for (const dialog of dialogs) {
                const text = dialog.textContent || '';

                // Look for "Joined" pattern - extract date after "Joined" label
                // Format: "JoinedJuly 2023" (no space) or "Joined July 2023" or "已加入 2023 年 7 月"
                const joinedPatterns = [
                    /Joined\s*([A-Za-z]+\s+\d{4})/i,  // "JoinedJuly 2023" or "Joined July 2023"
                    /已加入\s*(\d{4}\s*年\s*\d{1,2}\s*月)/,
                    /加入於\s*(\d{4}\s*年\s*\d{1,2}\s*月)/,
                ];

                for (const pattern of joinedPatterns) {
                    const match = text.match(pattern);
                    if (match) {
                        // Clean up: remove user number suffix (e.g., "· #1" or "· #2,697,767")
                        joinedDate = match[1].split(/\s*[·•]\s*/)[0].trim();
                        break;
                    }
                }

                // Look for location - "Based in" or "Location" label
                // Format: "Based inUnited States" or "Based in United States"
                const locationPatterns = [
                    /Based\s+in\s*([A-Za-z\s,]+?)(?:Verified|$)/i,  // "Based inUnited States"
                    /Location\s*[:：]?\s*([A-Za-z\s,]+?)(?:Verified|$)/i,
                    /所在地\s*[:：]?\s*(.+?)(?:認證|$)/,
                    /位置\s*[:：]?\s*(.+?)(?:認證|$)/,
                ];

                for (const pattern of locationPatterns) {
                    const match = text.match(pattern);
                    if (match) {
                        location = match[1].trim();
                        break;
                    }
                }
            }

            return { joinedDate, location };
        });

        // Close the dialog
        await page.keyboard.press('Escape');

        if (aboutData.joinedDate || aboutData.location) {
            return {
                data: aboutData,
                debug: { status: 200 },
            };
        }

        return {
            data: null,
            debug: { error: 'Could not extract data from About dialog' },
        };

    } catch (err) {
        return {
            data: null,
            debug: { error: `Error: ${String(err)}` },
        };
    }
}

// ============================================
// Exported Utilities
// ============================================

/**
 * Export parseRelativeTime for external use
 */
export { parseRelativeTime };

/**
 * Export parseStatNumber for external use
 */
export { parseStatNumber };

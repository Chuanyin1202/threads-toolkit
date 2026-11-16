/**
 * Crawler run helpers - shared across all actions
 *
 * Every action runs its own single-request PlaywrightCrawler. In batch mode several
 * of them run in one process, so each one must get its own request queue: sharing the
 * default queue makes later crawlers see the earlier handled request, hit
 * `maxRequestsPerCrawl: 1` before starting, and lets parallel crawlers steal each
 * other's requests.
 */

import type { PlaywrightCrawler } from 'crawlee';
import { RequestQueue } from 'crawlee';

/**
 * Open a uniquely named request queue for a single crawler run.
 * Always pair with `runSingleRequestCrawl`, which drops it afterwards.
 */
export async function openIsolatedQueue(label: string): Promise<RequestQueue> {
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return RequestQueue.open(`threads-${label}-${suffix}`);
}

/**
 * Run a crawler over a single URL using its isolated queue, then drop the queue.
 * Throws if the request failed after all retries, so callers (and batch mode)
 * see the failure instead of a silent empty result.
 */
export async function runSingleRequestCrawl(
    crawler: PlaywrightCrawler,
    requestQueue: RequestQueue,
    url: string,
    what: string,
): Promise<void> {
    try {
        const { requestId } = await requestQueue.addRequest({ url });
        const stats = await crawler.run();

        if (stats.requestsFailed > 0) {
            const request = await requestQueue.getRequest(requestId);
            const messages = request?.errorMessages ?? [];
            const lastError = messages.length > 0 ? messages[messages.length - 1].split('\n')[0] : undefined;
            throw new Error(`${what} failed: ${lastError ?? 'request failed after all retries'}`);
        }
    } finally {
        await requestQueue.drop().catch(() => undefined);
    }
}

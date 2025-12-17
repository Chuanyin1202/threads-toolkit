/**
 * Threads Toolkit - Type definitions
 */

// =============================================================================
// Input Types
// =============================================================================

export type ActionType = 'search' | 'profile' | 'hashtag' | 'post';
export type FilterType = 'recent' | 'top';
export type OutputFormat = 'json' | 'csv';

export interface ProxyConfiguration {
    useApifyProxy?: boolean;
    apifyProxyGroups?: string[];
    apifyProxyCountry?: string;
}

export interface RateLimitConfig {
    /** Delay between requests in milliseconds (default: 1000) */
    requestDelay?: number;
    /** Maximum retries when rate limited (default: 3) */
    maxRetries?: number;
    /** Initial backoff delay in milliseconds (default: 5000) */
    backoffDelay?: number;
    /** Backoff multiplier for exponential backoff (default: 2) */
    backoffMultiplier?: number;
}

export interface BaseInput {
    action: ActionType;
    maxItems?: number;
    outputFormat?: OutputFormat;
    proxyConfiguration?: ProxyConfiguration;
    useCookies?: boolean;
    storageState?: Record<string, unknown>;
    /** Rate limit protection settings */
    rateLimitConfig?: RateLimitConfig;
}

export interface SearchInput extends BaseInput {
    action: 'search';
    keyword: string;
    filter?: FilterType;
}

export interface ProfileInput extends BaseInput {
    action: 'profile';
    username: string;
    includePosts?: boolean;
}

export interface HashtagInput extends BaseInput {
    action: 'hashtag';
    tag: string;
    filter?: FilterType;
}

export interface PostInput extends BaseInput {
    action: 'post';
    postUrl: string;
}

export type Input = SearchInput | ProfileInput | HashtagInput | PostInput;
export type ActionInput = Input | BatchInput;

// =============================================================================
// Output Types
// =============================================================================

export interface Author {
    username: string;
    displayName: string;
    profileUrl: string;
    avatarUrl?: string;
    isVerified?: boolean;
}

export interface PostStats {
    likes: number;
    replies: number;
    reposts: number;
    shares: number;
}

export interface ThreadsPost {
    id: string;
    url: string;
    author: Author;
    content: string;
    timestamp: string;
    stats: PostStats;
    images?: string[];
    videos?: string[];
    quotedPost?: ThreadsPost;
    links?: string[];
}

export interface ProfileData {
    username: string;
    displayName: string;
    profileUrl: string;
    avatarUrl?: string;
    bio?: string;
    isVerified: boolean;
    followersCount?: number;
    followingCount?: number;
    postsCount?: number;
    location?: string | null;
    joinedDate?: string | null;
    partial?: boolean;
    missingFields?: string[];
}

// =============================================================================
// Internal Types
// =============================================================================

export interface CrawlerContext {
    input: Input;
    itemCount: number;
    maxItems: number;
}

export interface BatchInput {
    action: ActionType;
    keywords?: string[];
    usernames?: string[];
    tags?: string[];
    postUrls?: string[];
    maxItems?: number;
    filter?: FilterType;
    proxyConfiguration?: ProxyConfiguration;
    concurrency?: number;
    useCookies?: boolean;
    storageState?: Record<string, unknown>;
}

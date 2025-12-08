# Threads Toolkit

Languages: [English](README.md) | [中文](README.zh-TW.md)

A powerful and reliable Apify Actor for scraping Threads.net - Meta's text-based social media platform. Extract posts, profiles, hashtags, and replies without login. Export to JSON/CSV/Excel.

## Important: Data Scraping Limitations

**Threads data scraping has inherent limitations:**

- **Data Volume Limits**: Threads platform restricts accessible data volume. Actual results vary based on account activity, content type, and other factors
- **Dynamic Loading**: Threads uses infinite scroll to load content, but stops loading after a certain amount
- **Rate Limiting**: Excessive requests may trigger platform protection mechanisms
- **Content Availability**: Cannot access private accounts, deleted content, or region-restricted content
- **Login Walls**: Threads may occasionally display login walls that block scraping

### Best Practices

1. **Small Batch Testing**: Start with smaller limits for initial tests, gradually increase to find optimal settings
2. **Realistic Expectations**: Understand that actual results may be fewer than requested
3. **Error Handling**: Be prepared to handle partial failures or incomplete results
4. **Execution Intervals**: Avoid overly frequent scraping; recommend at least 5-10 minute intervals
5. **Data Validation**: Always verify that scraped data is complete and accurate
6. **Backup Plans**: For critical data, consider multiple scraping attempts or different parameters

## Features

- **Search Posts**: Search for posts by keyword with sorting options
- **Hashtag Search**: Search posts by hashtag tag
- **Profile Scraping**: Fetch user profile data including bio, follower count, verification status, and recent posts
- **Single Post Extraction**: Extract detailed data from a specific post by URL, including replies
- **Batch Mode**: Process multiple keywords/usernames/tags/URLs in one run with concurrency control
- **Media Extraction**: Capture image and video URLs from posts
- **No Login Required**: Scrapes public data only
- **Export Formats**: JSON, CSV, Excel

## Input Parameters

### Common Parameters

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `action` | string | Yes | Action type: `search`, `hashtag`, `profile`, or `post` | - |
| `proxyConfiguration` | object | No | Proxy settings for reliability | Apify Proxy |

### Authentication (Optional)

Enable cookie injection for extended data access. Useful when encountering login walls.

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `useCookies` | boolean | No | Enable cookie/storage injection | `false` |
| `storageState` | object | No | Playwright `storageState.json` content | - |

**How to obtain storageState:**

1. Login to Threads in your browser
2. Use Playwright to export storage state:
   ```javascript
   // After logging in with Playwright
   await context.storageState({ path: 'storageState.json' });
   ```
3. Copy the JSON content to the `storageState` field

**Note**: If `useCookies` is enabled but `storageState` is empty, the Actor falls back to no-auth mode with a warning. Only cookies and localStorage for Threads domains are injected; sessionStorage is not supported.

### Rate Limit Protection (Optional)

Configure rate limit protection to avoid being blocked by Threads.

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `rateLimitConfig.requestDelay` | integer | No | Delay between requests (ms) | `1000` |
| `rateLimitConfig.maxRetries` | integer | No | Max retries when rate limited | `3` |
| `rateLimitConfig.backoffDelay` | integer | No | Initial backoff delay (ms) | `5000` |
| `rateLimitConfig.backoffMultiplier` | number | No | Backoff multiplier | `2` |

**Example:**

```json
{
    "action": "search",
    "keyword": "AI",
    "rateLimitConfig": {
        "requestDelay": 2000,
        "maxRetries": 5,
        "backoffDelay": 10000
    }
}
```

**How it works:**
- When Threads returns a rate limit error, the Actor automatically pauses and retries
- Uses exponential backoff: first retry after 5s, second after 10s, third after 20s (with default settings)
- Logs warnings when rate limited to help you monitor and adjust settings

### Search Action

Search for posts by keyword on Threads.net.

```json
{
    "action": "search",
    "keyword": "artificial intelligence",
    "filter": "recent",
    "maxItems": 50
}
```

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `keyword` | string | Yes | Search keyword | - |
| `filter` | string | No | Sort results: `recent` or `top` | `recent` |
| `maxItems` | integer | No | Maximum posts to return (1-1000) | `50` |

### Hashtag Action

Search posts by hashtag.

```json
{
    "action": "hashtag",
    "tag": "AI",
    "filter": "recent",
    "maxItems": 50
}
```

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `tag` | string | Yes | Hashtag to search (with or without #) | - |
| `filter` | string | No | Sort results: `recent` or `top` | `recent` |
| `maxItems` | integer | No | Maximum posts to return (1-1000) | `50` |

### Profile Action

Fetch user profile data and recent posts.

```json
{
    "action": "profile",
    "username": "zuck",
    "maxItems": 20
}
```

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `username` | string | Yes | Username to fetch (without @) | - |
| `includePosts` | boolean | No | Also scrape recent posts from the profile page | `true` |
| `maxItems` | integer | No | Max posts to fetch from profile page | `20` |

### Post Action

Extract detailed data from a specific post including replies.

```json
{
    "action": "post",
    "postUrl": "https://www.threads.com/@zuck/post/ABC123xyz",
    "maxItems": 50
}
```

| Field | Type | Required | Description | Default |
|-------|------|----------|-------------|---------|
| `postUrl` | string | Yes | Full URL to the Threads post | - |
| `maxItems` | integer | No | Maximum replies to fetch | `50` |

### Batch Mode

Process multiple inputs in one run. `concurrency` controls how many tasks run in parallel.

```json
{
    "action": "search",
    "keywords": ["vibe coding", "machine learning"],
    "usernames": ["zuck", "openai"],
    "tags": ["AI", "tech"],
    "postUrls": ["https://www.threads.com/@user/post/ABC123"],
    "maxItems": 20,
    "filter": "recent",
    "concurrency": 2
}
```

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `keywords` | array | Multiple search keywords | `[]` |
| `usernames` | array | Multiple usernames | `[]` |
| `tags` | array | Multiple hashtags | `[]` |
| `postUrls` | array | Multiple post URLs | `[]` |
| `concurrency` | integer | Parallel task limit | `2` |

## Output Format

### Post Output

Each post is stored as a separate record:

```json
{
    "id": "ABC123xyz",
    "url": "https://www.threads.com/@johndoe/post/ABC123xyz",
    "author": {
        "username": "johndoe",
        "displayName": "John Doe",
        "profileUrl": "https://www.threads.com/@johndoe",
        "avatarUrl": "https://...",
        "isVerified": false
    },
    "content": "This is the post content about AI and technology...",
    "timestamp": "2025-12-04T10:14:34.000Z",
    "stats": {
        "likes": 142,
        "replies": 23,
        "reposts": 8
    },
    "images": ["https://..."],
    "videos": ["https://..."],
    "links": ["https://example.com"],
    "quotedPost": null,
    "source": "search",
    "parentId": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique post identifier |
| `url` | string | Direct link to the post |
| `author.username` | string | Author's username |
| `author.displayName` | string | Author's display name |
| `author.profileUrl` | string | Link to author's profile |
| `author.avatarUrl` | string | Author's avatar image URL |
| `author.isVerified` | boolean | Whether the author is verified |
| `content` | string | Post text content |
| `timestamp` | string | ISO 8601 timestamp |
| `stats.likes` | integer | Number of likes |
| `stats.replies` | integer | Number of replies |
| `stats.reposts` | integer | Number of reposts |
| `images` | array | Image URLs (if any) |
| `videos` | array | Video URLs (if any) |
| `links` | array | External links (non-Threads) |
| `quotedPost` | object | Minimal quoted post info if present |
| `source` | string | Source tag: `search`, `hashtag`, `reply`, `profile_posts` |
| `parentId` | string | If source is `reply`, the parent post ID |

### Profile Output

```json
{
    "username": "zuck",
    "displayName": "Mark Zuckerberg",
    "profileUrl": "https://www.threads.com/@zuck",
    "avatarUrl": "https://...",
    "bio": "Building the future...",
    "isVerified": true,
    "followersCount": 5417000,
    "location": "California, USA",
    "joinedDate": "July 2023",
    "partial": false,
    "missingFields": [],
    "type": "profile",
    "source": "profile"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `username` | string | Username |
| `displayName` | string | Display name |
| `profileUrl` | string | Profile URL |
| `avatarUrl` | string | Avatar image URL |
| `bio` | string | User bio text |
| `isVerified` | boolean | Whether the user is verified |
| `followersCount` | integer | Number of followers |
| `location` | string \| null | User's location (from "About this profile") |
| `joinedDate` | string \| null | Account creation month/year (e.g., "July 2023") |
| `partial` | boolean | True if some optional fields are missing |
| `missingFields` | array | Names of missing optional fields |

**Note:** `location` and `joinedDate` require authentication. Enable `useCookies` and provide `storageState` to access these fields. Without login, these fields will be `null`. See [Authentication](#authentication-optional) for setup instructions.

Note: Recent posts from the profile page are pushed as separate Dataset items with `source: "profile_posts"` and `profile: <username>`.

## Data Quality

- **Posts**: Entries missing essential data (content, author, or valid timestamp) are filtered out and not written to the Dataset
- **Profiles**: If optional fields are missing (e.g., bio/avatar/followers), the record is kept but marked with `partial: true` and `missingFields`
- **Replies and profile posts**: Reuse the same validation; invalid ones are skipped

## Use Cases

- **Social Media Monitoring**: Track brand mentions and conversations
- **Influencer Discovery**: Find content creators by follower metrics
- **Competitor Research**: Monitor competitor activity and engagement
- **Content Analysis**: Analyze trending topics and hashtags
- **Lead Generation**: Discover profiles in your niche
- **Market Research**: Understand audience sentiment

## Performance and Limitations

**Post Limits**:

- User posts: Only recent posts accessible, quantity varies by account
- Keyword search: Limited by Threads search results
- Profile search: Limited by search results

**Note**: Threads dynamically loads content, which may limit the amount of data retrievable through scrolling. Actual results may be fewer than the requested limit.

## Frequently Asked Questions

**Q: Why do I get fewer results than my maxItems limit?**
A: Threads limits the amount of content accessible through its interface. The actual number of available posts varies based on multiple factors including account activity, content type, etc.

**Q: Can I scrape private accounts?**
A: No. This Actor only scrapes publicly available data. Private accounts, deleted content, and region-restricted content cannot be accessed.

**Q: Why do some posts have truncated text?**
A: Threads displays truncated content in feeds. Use the post URL via HTTP request tools to get full content.

**Q: Are usernames with dots supported?**
A: Yes. Usernames like @user.name are fully supported.

**Q: How do I handle rate limiting?**
A: Use Apify Proxy (recommended), reduce concurrency, and add intervals between runs. If you encounter persistent issues, wait 10-15 minutes before retrying.

**Q: What happens if Threads shows a login wall?**
A: The Actor will log an error and skip that request. Consider using different proxy settings or reducing request frequency.

**Q: Can I get engagement metrics?**
A: Yes. The Actor extracts likes, replies, and reposts for each post to help you analyze content performance.

## Alternative: Official Threads API

**Important**: This Actor operates without login, meaning accessible data volume is limited by Threads' public interface.

**If you need to scrape your own account's data**, consider using the [Official Threads API](https://developers.facebook.com/docs/threads):

- More reliable and stable
- Higher rate limits
- Access to full post history
- No risk of being blocked
- Official support from Meta

The Threads API is the recommended method for accessing your own account data or for large-scale, production-level data extraction needs.

## Support

Have questions or issues?

- Check [Apify Documentation](https://docs.apify.com)
- View all fields in the dataset for complete data
- Report issues via the Issues tab
- Contact support through the Apify platform

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Disclaimer

This tool is for educational and research purposes only. Please use responsibly and comply with Threads' Terms of Service. The developers are not responsible for any misuse of this tool or violations of platform policies.

---

**Keywords**: Threads scraper, Threads API, Meta Threads, social media scraper, Instagram Threads, Threads posts, Threads data extraction, social media monitoring, Threads automation, influencer discovery, follower count scraper

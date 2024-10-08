// Generated by Wrangler on Fri Aug 16 2024 19:51:32 GMT-0400 (Atlantic Standard Time)
// by running `wrangler types --env-interface CloudflareBindings`

interface CloudflareBindings {
  CACHE: KVNamespace
  BROWSER: DurableObjectNamespace<import("./src/index").Browser>
  CRAWLER: Queue<{
    currentUrl: string
    originalUrl: string
    currentDepth: number
    maxDepth: number
    limit: number
    callback: string
    detailed?: boolean
  }>
  CALLBACKS: Queue<{
    callback: string
    url: string
  }>
  MY_BROWSER: Fetcher
}

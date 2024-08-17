import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { StatusCodes } from "http-status-codes"
import { z } from "zod"
import { bearerAuth } from "hono/bearer-auth"
import { env } from "hono/adapter"

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.get("/", (c) => c.text("Hello Wingmark!"))

app.post(
  "/scrape",
  zValidator(
    "json",
    z.object({
      url: z.string().url(),
      detailed: z.boolean().default(false),
      cache_enabled: z.boolean().default(true),
    }),
  ),
  async (c) => {
    const { url, cache_enabled: cacheEnabled, detailed } = c.req.valid("json")

    console.log("Scraping", url)
    console.log("Cache enabled:", cacheEnabled)

    if (cacheEnabled) {
      const cached = await c.env.CACHE.get(`scrape:${url}`)

      if (cached) {
        console.log("Cache hit!")

        return c.text(cached, { status: StatusCodes.OK })
      }
    }

    const id = c.env.BROWSER.idFromName("browser")
    const browser = c.env.BROWSER.get(id)

    const markdown = await browser.scrape(url, detailed)

    if (!markdown) {
      return c.text("Error: No response from scrape", {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      })
    }

    return c.text(markdown, { status: StatusCodes.OK })
  },
)

app.post(
  "/crawl",
  bearerAuth({
    verifyToken: async (token, c) => {
      const CRAWL_TOKEN = env<{ CRAWL_TOKEN: string }>(c, "workerd").CRAWL_TOKEN

      return token === CRAWL_TOKEN
    },
  }),
  zValidator(
    "json",
    z.object({
      url: z.string().url(),
      callback: z.string().url(),
      depth: z.number().min(1).max(3).default(1),
      limit: z.number().min(1).max(100).default(20),
      detailed: z.boolean().default(false),
      ignore_pattern: z.array(z.string().regex(/.*/)).default([]),
    }),
  ),
  async (c) => {
    const { url, depth, ...rest } = c.req.valid("json")

    await c.env.CRAWLER.send({
      ...rest,
      currentUrl: url,
      originalUrl: url,
      maxDepth: depth,
      currentDepth: 0,
    })

    return c.text("Received", { status: StatusCodes.ACCEPTED })
  },
)

export default app

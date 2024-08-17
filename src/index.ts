import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { StatusCodes } from "http-status-codes"
import ky from "ky"
import { z } from "zod"

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.post(
  "/scrape",
  zValidator(
    "json",
    z.object({
      url: z.string().url(),
      cache_enabled: z.enum(["true", "false"]).default("true"),
    }),
  ),
  async (c) => {
    const { url, cache_enabled } = c.req.valid("json")
    const cacheEnabled = cache_enabled === "true"

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

    const markdown = await browser.scrape(url)

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
  zValidator(
    "json",
    z.object({
      url: z.string().url(),
      callback: z.string().url(),
      depth: z.number().min(1).max(3).default(1),
      limit: z.number().min(1).max(100).default(20),
    }),
  ),
  async (c) => {
    const { url, callback, depth, limit } = c.req.valid("json")

    await c.env.CRAWLER.send({
      url,
      callback,
      maxDepth: depth,
      currentDepth: 0,
      limit,
    })

    return c.text("Received", { status: StatusCodes.ACCEPTED })
  },
)

export { Browser } from "@/lib/browser"

export default {
  fetch: app.fetch,
  queue: async (batch, env) => {
    console.log("Handling queue batch:", batch.queue)

    if (batch.queue === "wingmark-crawler") {
      const id = env.BROWSER.idFromName("browser")
      const browser = env.BROWSER.get(id)

      for (const message of batch.messages) {
        await browser.crawl(
          message.body as Parameters<typeof env.CRAWLER.send>[0],
        )

        await message.ack()
      }

      return
    }

    if (batch.queue === "wingmark-callbacks") {
      for (const message of batch.messages) {
        const body = message.body as Parameters<typeof env.CALLBACKS.send>[0]
        console.log("Posting to callback:", body.callback)

        await ky.post(body.callback, { body: body.markdown, retry: 3 })

        await message.ack()
      }

      return
    }

    throw new Error(`Unknown queue: ${batch.queue}`)
  },
} satisfies ExportedHandler<CloudflareBindings>

import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { StatusCodes } from "http-status-codes"
import { z } from "zod"

const app = new Hono<{ Bindings: CloudflareBindings }>()

app.get(
  "/scrape",
  zValidator(
    "query",
    z.object({
      url: z.string().url(),
      // crawl: z.enum(["true", "false"]).default("false"),
      cache: z.enum(["true", "false"]).default("true"),
    }),
  ),
  async (c) => {
    const { url, cache } = c.req.valid("query")

    console.log("Scraping", url)
    console.log("Cache enabled:", cache)

    if (cache === "true") {
      const cached = await c.env.CACHE.get(`scrape:${url}`)

      if (cached) {
        console.log("Cache hit!")

        return c.text(cached, { status: StatusCodes.OK })
      }
    }

    const id = c.env.BROWSER.idFromName("browser")
    const browser = c.env.BROWSER.get(id)

    const markdown = await browser.scrape(url)

    c.env.CACHE.put(`scrape:${url}`, markdown, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    if (!markdown) {
      return c.text("Error: No response from scrape", {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      })
    }

    return c.text(markdown, { status: StatusCodes.OK })
  },
)

export { Browser } from "@/lib/browser"
export default app

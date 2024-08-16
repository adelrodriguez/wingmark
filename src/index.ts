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

    await browser.scrape(url)

    const response = await c.env.CACHE.get(`scrape:${url}`)

    if (!response) {
      return c.text("Error: No response from scrape", {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      })
    }

    return c.text(response, { status: StatusCodes.OK })
  },
)

app.get(
  "/screenshot",
  zValidator(
    "query",
    z.object({
      url: z.string(),
      cache: z.enum(["true", "false"]).default("true"),
    }),
  ),
  async (c) => {
    const { url, cache } = c.req.valid("query")

    console.log("Screenshot", url)
    console.log("Cache enabled:", cache)

    if (cache === "true") {
      const cached = await c.env.CACHE.get(`screenshot:${url}`, {
        type: "arrayBuffer",
      })

      if (cached) {
        console.log("Cache hit!")

        return c.body(cached, {
          status: StatusCodes.OK,
          headers: { "Content-Type": "image/png" },
        })
      }
    }

    const id = c.env.BROWSER.idFromName("browser")
    const browser = c.env.BROWSER.get(id)

    await browser.screenshot(url)

    const response = await c.env.CACHE.get(`screenshot:${url}`, {
      type: "arrayBuffer",
    })

    if (!response) {
      return c.text("Error: No response from screenshot", {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
      })
    }

    return c.body(response, {
      status: StatusCodes.OK,
      headers: { "Content-Type": "image/png" },
    })
  },
)

export { Browser } from "@/lib/browser"
export default app

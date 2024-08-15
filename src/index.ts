import { DurableObject } from "cloudflare:workers"
import { until } from "@/utils/until"
import puppeteer, {
  type Browser as PuppeteerBrowser,
} from "@cloudflare/puppeteer"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { StatusCodes } from "http-status-codes"
import { z } from "zod"
import TurndownService from "turndown"
import { createDocument } from "@mixmark-io/domino"
import { Readability } from "@mozilla/readability"

type Bindings = {
  [key in keyof CloudflareBindings]: CloudflareBindings[key]
}

const app = new Hono<{ Bindings: Bindings }>()

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

    return c.body(response, {
      status: StatusCodes.OK,
      headers: { "Content-Type": "image/png" },
    })
  },
)

export class Browser extends DurableObject<Bindings> {
  ctx: DurableObjectState
  env: CloudflareBindings
  keptAliveInSeconds: number
  storage: DurableObjectStorage
  browser?: PuppeteerBrowser

  private KEEP_BROWSER_ALIVE_IN_SECONDS = 60

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)
    this.ctx = ctx
    this.env = env
    this.storage = this.ctx.storage
    this.keptAliveInSeconds = 0
  }

  async fetch() {
    return new Response("Browser DO: fetch")
  }

  async screenshot(url: string) {
    // If there's a browser session open, re-use it
    if (!this.browser || !this.browser.isConnected()) {
      console.log("Browser DO: Starting new instance")

      const [result, error] = await until(() =>
        puppeteer.launch(this.env.BROWSER_INSTANCE),
      )

      if (error) {
        console.log(
          "Browser DO: Could not start browser instance. Error:",
          error,
        )

        return
      }

      this.browser = result
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0

    const page = await this.browser.newPage()

    await page.goto(url)

    const img = await page.screenshot({ fullPage: true })

    await this.env.CACHE.put(`screenshot:${url}`, img, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    await page.close()

    // Reset keptAlive after performing tasks to the DO.
    this.keptAliveInSeconds = 0

    // set the first alarm to keep DO alive
    const currentAlarm = await this.storage.getAlarm()

    if (currentAlarm == null) {
      console.log("Browser DO: setting alarm")
      const TEN_SECONDS = 10 * 1000

      await this.storage.setAlarm(Date.now() + TEN_SECONDS)
    }

    await this.env.CACHE.put(`scrape:${url}`, img, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    return img
  }

  async scrape(url: string) {
    // If there's a browser session open, re-use it
    if (!this.browser || !this.browser.isConnected()) {
      console.log("Browser DO: Starting new instance")

      const [result, error] = await until(() =>
        puppeteer.launch(this.env.BROWSER_INSTANCE),
      )

      if (error) {
        console.log(
          "Browser DO: Could not start browser instance. Error:",
          error,
        )

        return
      }

      this.browser = result
    }

    // Reset keptAlive after each call to the DO
    this.keptAliveInSeconds = 0

    const page = await this.browser.newPage()

    await page.goto(url, { waitUntil: "networkidle0" })

    const html = await page.content()
    const document = createDocument(html)
    const turndown = new TurndownService()
    const readability = new Readability(document)
    // const text = readability.parse()?.content
    const text = await turndown.turndown(document)
    // const text = await turndown.turndown(readability.parse()!.content)

    await this.env.CACHE.put(`scrape:${url}`, text, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    await page.close()

    // Reset keptAlive after performing tasks to the DO.
    this.keptAliveInSeconds = 0

    // set the first alarm to keep DO alive
    const currentAlarm = await this.storage.getAlarm()

    if (currentAlarm == null) {
      console.log("Browser DO: setting alarm")
      const TEN_SECONDS = 10 * 1000

      await this.storage.setAlarm(Date.now() + TEN_SECONDS)
    }

    return true
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    // Extend browser DO life
    if (this.keptAliveInSeconds < this.KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(
        `Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`,
      )
      await this.storage.setAlarm(Date.now() + 10 * 1000)
      // You could ensure the ws connection is kept alive by requesting something
      // or just let it close automatically when there  is no work to be done
      // for example, `await this.browser.version()`
    } else {
      console.log(
        `Browser DO: exceeded life of ${this.KEEP_BROWSER_ALIVE_IN_SECONDS}s.`,
      )

      if (this.browser) {
        console.log("Closing browser.")
        await this.browser.close()
      }
    }
  }
}

export default app

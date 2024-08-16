import puppeteer, {
  type Browser as PuppeteerBrowser,
} from "@cloudflare/puppeteer"
import { zValidator } from "@hono/zod-validator"
import { DurableObject } from "cloudflare:workers"
import { Hono } from "hono"
import { StatusCodes } from "http-status-codes"
import { z } from "zod"
import { BrowserError, ReadabilityError, until } from "@/utils/error"
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"

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

export class Browser extends DurableObject<Bindings> {
  ctx: DurableObjectState
  env: CloudflareBindings
  keptAliveInSeconds: number
  storage: DurableObjectStorage
  browser?: PuppeteerBrowser | null

  private KEEP_BROWSER_ALIVE_IN_SECONDS = 60
  private MAX_RETRIES = 3

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
    const browser = await this.ensureBrowser()

    // Reset keptAlive after each call to the DO
    this.ensureKeepAlive()

    const page = await browser.newPage()

    await page.goto(url, { waitUntil: "networkidle0" })

    const image = await page.screenshot({ fullPage: true })

    await this.env.CACHE.put(`screenshot:${url}`, image, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    await page.close()

    // Reset keptAlive after performing tasks to the DO.
    this.ensureKeepAlive()

    // set the first alarm to keep DO alive
    this.ensureBrowserAlarm()

    return
  }

  async scrape(url: string) {
    const browser = await this.ensureBrowser()

    // Reset keptAlive after each call to the DO
    this.ensureKeepAlive()

    const page = await browser.newPage()

    await page.goto(url, { waitUntil: "networkidle0" })

    const html = await page.content()
    const markdown = this.getMarkdown(html)

    await page.close()

    await this.env.CACHE.put(`scrape:${url}`, markdown, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    // Reset keptAlive after performing tasks to the DO.
    this.ensureKeepAlive()

    // set the first alarm to keep DO alive
    this.ensureBrowserAlarm()

    return true
  }

  private getMarkdown(html: string): string {
    const { document } = parseHTML(html)

    const article = new Readability(document, {
      // We use this serializer to return another DOM element so it can be
      // parsed by turndown
      serializer: (el) => el,
    }).parse()

    if (!article?.content) {
      throw new ReadabilityError()
    }

    const turndownService = new TurndownService()

    const markdown = turndownService.turndown(article.content)

    return markdown
  }

  private async ensureBrowser(): Promise<PuppeteerBrowser> {
    if (this.browser?.isConnected()) return this.browser

    let retries = 0

    while (retries < this.MAX_RETRIES) {
      try {
        // @ts-expect-error - Seems there was a breaking change in the types for
        // the browser. Needs more investigation or wait for a fix.
        this.browser = await puppeteer.launch(this.env.MY_BROWSER)

        return this.browser
      } catch (error) {
        console.log(
          "Browser DO: Could not start browser instance. Error:",
          error,
        )
        console.log("Retries left:", retries)

        await this.closeBrowserSessions()

        await new Promise((resolve) => setTimeout(resolve, 1000 * retries))

        console.log
        retries++
      }
    }

    throw new BrowserError()
  }

  private async closeBrowserSessions() {
    // @ts-expect-error - Seems there was a breaking change in the types for
    // the browser. Needs more investigation or wait for a fix.
    const sessions = await puppeteer.sessions(this.env.MY_BROWSER)

    for (const session of sessions) {
      const [error, browser] = await until(() =>
        // @ts-expect-error - Seems there was a breaking change in the types for
        // the browser. Needs more investigation or wait for a fix.
        puppeteer.connect(this.env.MY_BROWSER, session.sessionId),
      )

      if (error) {
        console.log(
          "Browser DO: Could not close browser session. Error:",
          error,
        )

        return
      }

      await browser.close()
    }
  }

  private async ensureBrowserAlarm() {
    const currentAlarm = await this.storage.getAlarm()

    if (currentAlarm == null) {
      console.log("Browser DO: setting alarm")
      const TEN_SECONDS = 10 * 1000

      await this.storage.setAlarm(Date.now() + TEN_SECONDS)
    }
  }

  private async ensureKeepAlive() {
    this.keptAliveInSeconds = 0
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

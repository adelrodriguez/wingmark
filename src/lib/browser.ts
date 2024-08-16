import puppeteer, {
  type Browser as PuppeteerBrowser,
} from "@cloudflare/puppeteer"
import { DurableObject } from "cloudflare:workers"
import { BrowserError, ReadabilityError, until } from "@/utils/error"
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"

export class Browser extends DurableObject<CloudflareBindings> {
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

    // TODO(adelrodriguez): Improve this so we can get more data from the HTML. Right now it is removing titlte
    const article = new Readability(document, {
      // We use this serializer to return another DOM element so it can be
      // parsed by turndown
      serializer: (el) => el,
      nbTopCandidates: 500,
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

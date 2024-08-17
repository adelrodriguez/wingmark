import puppeteer, {
  type Page,
  type Browser as PuppeteerBrowser,
} from "@cloudflare/puppeteer"
import { DurableObject } from "cloudflare:workers"
import { BrowserError, ReadabilityError, until } from "@/utils/error"
import { Readability } from "@mozilla/readability"
import { parseHTML } from "linkedom"
import TurndownService from "turndown"
import { parse } from "tldts"

export class Browser extends DurableObject<CloudflareBindings> {
  keptAliveInSeconds: number
  storage: DurableObjectStorage
  browser?: PuppeteerBrowser | null

  private KEEP_BROWSER_ALIVE_IN_SECONDS = 60
  private MAX_RETRIES = 3

  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env)

    this.storage = ctx.storage
    this.keptAliveInSeconds = 0
  }

  async crawl({
    url,
    callback,
    currentDepth = 0,
    maxDepth,
    limit,
  }: {
    url: string
    callback: string
    maxDepth: number
    currentDepth: number
    limit: number
  }): Promise<void> {
    if (currentDepth >= maxDepth) return

    // Reset keptAlive after each call to the DO
    this.ensureKeepAlive()

    const browser = await this.ensureBrowser()
    const page = await browser.newPage()

    await page.goto(url, { waitUntil: "networkidle0" })

    const links = await this.extractLinks(page, url, limit)

    this.env.CRAWLER.sendBatch(
      links.map((link) => ({
        body: {
          url: link,
          currentDepth: currentDepth + 1,
          maxDepth,
          limit,
          callback,
        },
      })),
    )

    const html = await page.content()

    const markdown = await this.getMarkdown(html)

    await this.env.CACHE.put(`scrape:${url}`, markdown, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    await this.env.CALLBACKS.send({ callback, markdown })

    await page.close()

    // Reset keptAlive after performing tasks to the DO.
    this.ensureKeepAlive()

    // set the first alarm to keep DO alive
    this.ensureBrowserAlarm()
  }

  async scrape(url: string): Promise<string> {
    const browser = await this.ensureBrowser()

    // Reset keptAlive after each call to the DO
    this.ensureKeepAlive()

    const page = await browser.newPage()

    await page.goto(url, { waitUntil: "networkidle0" })

    const html = await page.content()

    const markdown = this.getMarkdown(html)

    await this.env.CACHE.put(`scrape:${url}`, markdown, {
      expirationTtl: 60 * 60 * 24, // One day
    })

    await page.close()

    // Reset keptAlive after performing tasks to the DO.
    this.ensureKeepAlive()

    // set the first alarm to keep DO alive
    this.ensureBrowserAlarm()

    return markdown
  }

  private getMarkdown(html: string): string {
    const { document } = parseHTML(html)

    const reader = new Readability(document, {
      // We use this serializer to return another DOM element so it can be
      // parsed by turndown
      serializer: (el) => el,
      nbTopCandidates: 500,
      charThreshold: 0,
    })
    const article = reader.parse()

    if (!article?.content) {
      throw new ReadabilityError()
    }

    const turndownService = new TurndownService({ hr: "---" })

    const markdown = turndownService.turndown(article.content)

    return markdown
  }

  private async extractLinks(
    page: Page,
    url: string,
    limit: number,
  ): Promise<string[]> {
    const { hostname } = parse(url)
    const links = new Set<string>()

    const linksElements = await page.$$("a")

    for (const linkElement of linksElements) {
      const href = await linkElement.getProperty("href")
      const link = await href.jsonValue()

      if (!link?.contains(hostname)) continue

      links.add(link)

      if (links.size >= limit) break
    }

    return [...links]
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

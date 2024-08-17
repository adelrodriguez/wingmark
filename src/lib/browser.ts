import { BrowserError, ReadabilityError, until } from "@/utils/error"
import puppeteer, {
  type Page,
  type Browser as PuppeteerBrowser,
} from "@cloudflare/puppeteer"
import { Readability } from "@mozilla/readability"
import { DurableObject } from "cloudflare:workers"
import { toHtml } from "hast-util-to-html"
import { parseHTML } from "linkedom"
import rehypeParse from "rehype-parse"
import rehypeRemark from "rehype-remark"
import remarkStringify from "remark-stringify"
import TurndownService from "turndown"
import { unified } from "unified"
import { remove } from "unist-util-remove"

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

  async scrape(url: string, detailed?: boolean): Promise<string> {
    const browser = await this.ensureBrowser()

    this.ensureKeepAlive()

    const page = await browser.newPage()

    try {
      await page.goto(url, { waitUntil: "networkidle0" })

      const html = await page.content()

      const markdown = await this.getMarkdown(html, detailed)

      await this.env.CACHE.put(`scrape:${url}`, markdown, {
        expirationTtl: 60 * 60, // One hour
      })

      return markdown
    } finally {
      await page.close()
      this.ensureKeepAlive()
      this.ensureBrowserAlarm()
    }
  }

  async crawl({
    currentUrl,
    originalUrl,
    callback,
    currentDepth = 0,
    maxDepth,
    limit,
    detailed,
  }: {
    currentUrl: string
    originalUrl: string
    callback: string
    maxDepth: number
    currentDepth: number
    limit: number
    detailed?: boolean
  }): Promise<void> {
    console.log("Crawling:", currentUrl)
    console.log("Current depth:", currentDepth)

    if (currentDepth > maxDepth) {
      console.log("Crawling depth reached:", maxDepth)
      return
    }

    this.ensureKeepAlive()

    const browser = await this.ensureBrowser()
    const page = await browser.newPage()

    try {
      await page.goto(currentUrl, { waitUntil: "networkidle0" })

      const links = await this.extractLinks(page, originalUrl, limit)

      for (const link of links) {
        console.log("Queueing link:", link)

        this.env.CRAWLER.send({
          currentUrl: link,
          originalUrl,
          currentDepth: currentDepth + 1,
          maxDepth,
          limit,
          callback,
          detailed,
        })
      }

      const html = await page.content()

      let markdown = await this.env.CACHE.get(`scrape:${currentUrl}`)

      if (!markdown) {
        markdown = await this.getMarkdown(html, detailed)

        await this.env.CACHE.put(`scrape:${currentUrl}`, markdown, {
          expirationTtl: 60 * 60, // One hour
        })
      }

      await this.env.CALLBACKS.send({ callback, markdown })
    } finally {
      await page.close()
      this.ensureKeepAlive()
      this.ensureBrowserAlarm()
    }
  }

  private async getMarkdown(html: string, detailed = false): Promise<string> {
    if (detailed) {
      return this.getDetailedMarkdown(html)
    }

    return this.getSummaryMarkdown(html)
  }

  private getSummaryMarkdown(html: string): string {
    const { document } = parseHTML(html)

    const reader = new Readability(document, {
      serializer: (el) => el,
      nbTopCandidates: 500,
      charThreshold: 0,
    })
    const article = reader.parse()

    if (!article?.content) {
      throw new ReadabilityError()
    }

    const turndownService = new TurndownService({ hr: "---" })

    let markdown = turndownService.turndown(article.content)

    markdown = `Ttile: ${article.title}\n\n${markdown}`

    return markdown
  }

  private async getDetailedMarkdown(html: string): Promise<string> {
    const file = await unified()
      .use(rehypeParse, { fragment: true })
      .use(() => (tree) => {
        // Remove comments
        remove(tree, "comment")
      })
      .use(rehypeRemark, {
        handlers: {
          table(state, node) {
            const value = toHtml(node)
            state.patch(node, { type: "html", value })

            return { type: "html", value }
          },
        },
      })
      .use(remarkStringify, {
        bullet: "-",
        listItemIndent: "one",
        strong: "*",
        emphasis: "_",
      })
      .process(html)

    return String(file)
  }

  private async extractLinks(
    page: Page,
    url: string,
    limit: number,
  ): Promise<string[]> {
    console.log("Extracting links from:", url)

    const links = new Set<string>()

    const hrefs: string[] = await page.$$eval("a", (anchors) =>
      anchors.map((a) => a.href),
    )

    for (const href of hrefs) {
      if (!href.startsWith(url)) continue

      links.add(href)

      if (links.size >= limit) break
    }

    console.log("Found links:", links.size)

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
        console.error(
          "Browser DO: Could not start browser instance. Error:",
          error,
        )
        console.log("Retries left:", this.MAX_RETRIES - retries - 1)

        await this.closeBrowserSessions()

        await new Promise((resolve) =>
          setTimeout(resolve, 1000 * (retries + 1)),
        )

        retries++
      }
    }

    throw new BrowserError()
  }

  private async closeBrowserSessions() {
    try {
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
          console.error(
            "Browser DO: Could not close browser session. Error:",
            error,
          )
          continue
        }

        await browser.close()
      }
    } catch (error) {
      console.error("Error closing browser sessions:", error)
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

  private ensureKeepAlive() {
    this.keptAliveInSeconds = 0
  }

  async alarm() {
    this.keptAliveInSeconds += 10

    if (this.keptAliveInSeconds < this.KEEP_BROWSER_ALIVE_IN_SECONDS) {
      console.log(
        `Browser DO: has been kept alive for ${this.keptAliveInSeconds} seconds. Extending lifespan.`,
      )
      await this.storage.setAlarm(Date.now() + 10 * 1000)
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

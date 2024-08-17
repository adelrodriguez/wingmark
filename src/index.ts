import ky from "ky"
import app from "@/http"

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

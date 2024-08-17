import ky from "ky"

export async function postToCallback(
  env: CloudflareBindings,
  body: Parameters<typeof env.CALLBACKS.send>[0],
) {
  await ky.post(body.callback, { body: body.markdown, retry: 3 })
}

export async function executeCrawl(
  env: CloudflareBindings,
  body: Parameters<typeof env.CRAWLER.send>[0],
) {
  const id = env.BROWSER.idFromName("browser")
  const browser = env.BROWSER.get(id)

  await browser.crawl(body)
}

export const queueHandler: ExportedHandlerQueueHandler<
  CloudflareBindings
> = async (batch, env) => {
  if (batch.queue === "wingmark-crawler") {
    for (const message of batch.messages) {
      await executeCrawl(
        env,
        message.body as Parameters<typeof env.CRAWLER.send>[0],
      )

      await message.ack()
    }
  }

  if (batch.queue === "wingmark-callbacks") {
    for (const message of batch.messages) {
      await postToCallback(
        env,
        message.body as Parameters<typeof env.CALLBACKS.send>[0],
      )

      await message.ack()
    }
  }

  throw new Error("Unknown queue")
}

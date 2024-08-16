export class BrowserError extends Error {
  message = "Unable to start browser instance"
}

export class ReadabilityError extends Error {
  message = "Unable to parse article content"
}

export async function until<
  F extends (...args: unknown[]) => Promise<unknown>,
  E extends Error = Error,
>(promise: F): Promise<[null, Awaited<ReturnType<F>>] | [E, null]> {
  try {
    const data = await promise()

    return [null, data as Awaited<ReturnType<F>>]
  } catch (error) {
    return [error as E, null]
  }
}

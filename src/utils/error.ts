export class BrowserError extends Error {
  message = "Unable to start browser instance"
}

export class ReadabilityError extends Error {
  message = "Unable to parse article content"
}

export class InternalError extends Error {}

import { checkIsValidChildUrl } from "@/utils/url"
import { describe, expect, it } from "vitest"

describe("isValidChildUrl", () => {
  it("should return true for a valid child URL", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com",
        "https://example.com/path/to/page",
      ),
    ).toBe(true)
  })

  it("should return false the same URL", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com/path/to/page",
        "https://example.com/path/to/page",
      ),
    ).toBe(false)
  })

  it("should return true if the child is a pathname", () => {
    expect(checkIsValidChildUrl("https://example.com", "/subpath")).toBe(true)
    expect(checkIsValidChildUrl("https://example.com/", "/subpath")).toBe(true)
    expect(
      checkIsValidChildUrl("https://example.com/path/to/page", "subpath"),
    ).toBe(false)
    expect(
      checkIsValidChildUrl("https://example.com/path/to/page/", "/subpath"),
    ).toBe(true)
  })

  it("should return false for a URL that is not a child URL", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com/path/to/page/other",
        "https://example.com/path/to/page",
      ),
    ).toBe(false)
  })

  it("should return false for a URL that has a hash", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com/path/to/page#hash",
        "https://example.com/path/to/page",
      ),
    ).toBe(false)
  })

  it("should return false for a URL that ends with a slash", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com/path/to/page/",
        "https://example.com/path/to/page",
      ),
    ).toBe(false)
  })

  it("should return false for a URL that ends with a slash and has a hash", () => {
    expect(
      checkIsValidChildUrl(
        "https://example.com/path/to/page/#hash",
        "https://example.com/path/to/page",
      ),
    ).toBe(false)
  })
})

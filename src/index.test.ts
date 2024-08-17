import { expect, it } from "vitest"
import app from "@/http"

it("should return 200 OK", async () => {
  const res = await app.request("/")

  expect(res.status).toBe(200)
  expect(await res.text()).toBe("Hello Wingmark!")
})

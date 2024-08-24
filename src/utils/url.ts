export function checkIsValidChildUrl(parent: string, child: string): boolean {
  const parentUrl = new URL(parent)
  const childUrl = new URL(child)

  return (
    child.startsWith(parent) &&
    !child.slice(parent.length).startsWith("#") &&
    !child.endsWith("/") &&
    childUrl.pathname.startsWith(parentUrl.pathname) &&
    childUrl.pathname !== parentUrl.pathname
  )
}

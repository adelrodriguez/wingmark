export function checkIsValidChildUrl(parent: string, child: string): boolean {
  try {
    const parentUrl = new URL(parent)
    const childUrl = new URL(child, parentUrl.href) // Use parent as base for relative URLs

    // Normalize URLs by removing trailing slashes
    const normalizedParent = parentUrl.href.replace(/\/$/, "")
    const normalizedChild = childUrl.href.replace(/\/$/, "")

    // Check if child is a direct subpath of parent
    const parentPath = parentUrl.pathname.replace(/\/$/, "")
    const childPath = childUrl.pathname.replace(/\/$/, "")

    return (
      normalizedChild.startsWith(normalizedParent) &&
      childPath.startsWith(parentPath) &&
      childPath !== parentPath &&
      childUrl.hash === "" // Ensure child URL doesn't have a hash
    )
  } catch (error) {
    // If either of the URLs are invalid, return false
    return false
  }
}

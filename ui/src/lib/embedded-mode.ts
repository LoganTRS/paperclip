/**
 * Embedded-mode signal.
 *
 * The Wayfinder board opens the full issue detail page in a same-origin iframe
 * side pane so an operator can read AND answer a ticket without leaving the map.
 * When the app boots *inside* that iframe it renders in "embedded" mode:
 *
 *   1. History isolation — the router runs on in-memory history instead of the
 *      browser history, so the embedded page's own navigate() calls (create
 *      issue → jump to it, back, etc.) do NOT pollute the parent Wayfinder
 *      tab's back/forward history (iframe history is shared with the parent by
 *      default).
 *   2. Compact shell — the global Sidebar / full topbar chrome is hidden so the
 *      embedded page does not duplicate the host app's navigation.
 *
 * The signal is the `embedded` query param (set by the Wayfinder pane's iframe
 * src), read at boot. It is deliberately an explicit opt-in rather than a bare
 * `window.self !== window.top` check, so a user who opens the app in a browser
 * iframe of their own choosing (e.g. a reader extension) still gets the full
 * app + full browser history unless the app itself embedded it.
 */
export function isEmbeddedMode(search: string = window.location.search): boolean {
  try {
    return new URLSearchParams(search).has("embedded");
  } catch {
    return false;
  }
}

/**
 * True when the current window is a same-origin top-level app that is *hosting*
 * an embedded child (i.e. we are the parent, not the embed). Used by the
 * host-side pane logic, not by the embedded boot path.
 */
export function isSameOriginFrameHost(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

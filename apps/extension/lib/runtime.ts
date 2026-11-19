// Generic typed messaging between extension contexts (panel, background,
// content script). Each feature defines its own message map on top of this.

export type ErrorResponse = { error: string; message?: string; tabUrl?: string | null };

export function isError(r: unknown): r is ErrorResponse {
  return !!r && typeof r === 'object' && 'error' in r && typeof (r as ErrorResponse).error === 'string';
}

/** A map of message type → { req, res }. */
export type MessageMap<M> = { [K in keyof M]: { req: { type: K }; res: unknown } };

export function send<M extends MessageMap<M>, K extends keyof M>(msg: M[K]['req']): Promise<M[K]['res']> {
  return browser.runtime.sendMessage(msg);
}

export function sendToTab<M extends MessageMap<M>, K extends keyof M>(tabId: number, msg: M[K]['req']): Promise<M[K]['res']> {
  return browser.tabs.sendMessage(tabId, msg);
}

/**
 * Register an async handler. Return undefined for messages it doesn't handle,
 * so several handlers can share one context. Uses sendResponse + `return true`,
 * the form every browser supports.
 */
export function serve<Req extends { type: string }>(handler: (msg: Req) => Promise<unknown> | undefined) {
  browser.runtime.onMessage.addListener((msg: Req, _sender, sendResponse) => {
    const result = handler(msg);
    if (!result) return false;
    result.then(sendResponse, (e) => sendResponse({ error: 'handler_failed', message: String(e) }));
    return true;
  });
}

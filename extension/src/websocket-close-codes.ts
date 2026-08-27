/** Codes supplied by browser JavaScript must be 1000 or in the private 3000-4999 range. */
export const ExtensionWebSocketCloseCode = {
  NORMAL: 1000,
  PROTOCOL_POLICY_VIOLATION: 4008,
} as const;

export type ExtensionWebSocketCloseCode =
  (typeof ExtensionWebSocketCloseCode)[keyof typeof ExtensionWebSocketCloseCode];

export function isValidBrowserWebSocketCloseCode(code: number): boolean {
  return code === 1000 || (code >= 3000 && code <= 4999);
}

interface BrowserSocketCloser {
  close(code?: number, reason?: string): void;
}

export function closeExtensionSocket(
  socket: BrowserSocketCloser,
  code: ExtensionWebSocketCloseCode,
  reason: string,
): void {
  if (!isValidBrowserWebSocketCloseCode(code)) {
    throw new Error("Invalid browser WebSocket close code");
  }
  socket.close(code, reason);
}

/** Transport failure supplies no application code; the close event owns reconnect scheduling. */
export function closeAfterTransportError(socket: BrowserSocketCloser): void {
  socket.close();
}

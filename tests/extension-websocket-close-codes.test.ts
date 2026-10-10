import { describe, expect, it, vi } from "vitest";
import {
  ExtensionWebSocketCloseCode,
  closeAfterTransportError,
  closeExtensionSocket,
  isValidBrowserWebSocketCloseCode,
} from "../extension/src/websocket-close-codes.js";

describe("extension WebSocket close codes", () => {
  it("defines only browser-valid application close codes", () => {
    for (const code of Object.values(ExtensionWebSocketCloseCode)) {
      expect(isValidBrowserWebSocketCloseCode(code)).toBe(true);
    }
  });

  it("refuses an invalid browser close code before invoking WebSocket.close", () => {
    const close = vi.fn();
    expect(() => closeExtensionSocket({ close }, 1008 as never, "Policy violation")).toThrow(
      "Invalid browser WebSocket close code",
    );
    expect(close).not.toHaveBeenCalled();
  });

  it("maps protocol or policy rejection to private code 4008, never RFC code 1008", () => {
    const close = vi.fn();
    closeExtensionSocket(
      { close },
      ExtensionWebSocketCloseCode.PROTOCOL_POLICY_VIOLATION,
      "Malformed bridge message",
    );
    expect(close).toHaveBeenCalledWith(4008, "Malformed bridge message");
    expect(close).not.toHaveBeenCalledWith(1008, expect.anything());
  });

  it("uses code 1000 for extension-initiated normal pairing shutdown", () => {
    const close = vi.fn();
    closeExtensionSocket(
      { close },
      ExtensionWebSocketCloseCode.NORMAL,
      "Pairing complete",
    );
    expect(close).toHaveBeenCalledWith(1000, "Pairing complete");
  });

  it("uses the private protocol code for malformed and unsupported bridge input", () => {
    expect(ExtensionWebSocketCloseCode.PROTOCOL_POLICY_VIOLATION).toBe(4008);
    expect(isValidBrowserWebSocketCloseCode(4008)).toBe(true);
    expect(isValidBrowserWebSocketCloseCode(1008)).toBe(false);
  });

  it("supplies no application code when the local bridge transport is unavailable", () => {
    const close = vi.fn();
    closeAfterTransportError({ close });
    expect(close).toHaveBeenCalledWith();
  });
});

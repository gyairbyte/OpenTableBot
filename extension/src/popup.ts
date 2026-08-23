function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing popup element ${id}`);
  return value as T;
}

const statusElement = element<HTMLDivElement>("status");
const codeElement = element<HTMLInputElement>("code");
const portElement = element<HTMLInputElement>("port");
const pairButton = element<HTMLButtonElement>("pair");

async function refreshStatus(): Promise<void> {
  const status: unknown = await chrome.runtime.sendMessage({ type: "OTB_GET_STATUS" });
  if (typeof status !== "object" || status === null) {
    statusElement.textContent = "Status unavailable";
    return;
  }
  const values = status as Record<string, unknown>;
  statusElement.textContent = values.connected === true
    ? values.pageReady === true
      ? "Connected; OpenTable page ready"
      : "Connected; open www.opentable.com"
    : values.paired === true
      ? "Paired; local bridge is offline"
      : "Not paired";
}

pairButton.addEventListener("click", () => {
  pairButton.disabled = true;
  statusElement.textContent = "Pairing…";
  void chrome.runtime
    .sendMessage({ type: "OTB_PAIR", code: codeElement.value, port: Number(portElement.value) })
    .then((response: unknown) => {
      if (typeof response !== "object" || response === null || (response as Record<string, unknown>).ok !== true) {
        const error = typeof response === "object" && response !== null
          ? (response as Record<string, unknown>).error
          : undefined;
        throw new Error(typeof error === "string" ? error : "Pairing failed");
      }
      codeElement.value = "";
      return refreshStatus();
    })
    .catch((error: unknown) => {
      statusElement.textContent = error instanceof Error ? error.message : "Pairing failed";
    })
    .finally(() => {
      pairButton.disabled = false;
    });
});

void refreshStatus().catch(() => {
  statusElement.textContent = "Status unavailable";
});

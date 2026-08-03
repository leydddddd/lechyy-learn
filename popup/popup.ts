const btn = document.getElementById("toggle-panel") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLParagraphElement;

let panelActive = false;

btn.addEventListener("click", async () => {
  btn.disabled = true;
  statusEl.textContent = panelActive ? "Closing panel\u2026" : "Opening panel\u2026";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    statusEl.textContent = "No active tab";
    btn.disabled = false;
    return;
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: panelActive ? "lechyy-panel-hide" : "lechyy-panel-show",
    });
    panelActive = response?.panelActive ?? !panelActive;
    btn.textContent = panelActive ? "Close panel" : "Translate this page";
    btn.disabled = false;
    statusEl.textContent = panelActive ? "Panel open" : "Panel closed";
  } catch {
    statusEl.textContent = "Cannot reach page \u2014 reload?";
    btn.disabled = false;
  }
});
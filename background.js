// background.js - Service Worker for Lichess Stockfish Bot Extension

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendMouseEvent(tabId, type, x, y, button = 'left') {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: type,
      x: x,
      y: y,
      button: button,
      clickCount: type === 'mousePressed' || type === 'mouseReleased' ? 1 : 0
    }, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function performDebuggerMove(tabId, fromCoords, toCoords) {
  return new Promise((resolve, reject) => {
    const target = { tabId };
    chrome.debugger.attach(target, "1.3", async () => {
      const err = chrome.runtime.lastError;
      if (err && !err.message.includes("already attached")) {
        return reject(new Error(err.message));
      }

      try {
        // Move to start square and click
        await sendMouseEvent(tabId, 'mouseMoved', fromCoords.x, fromCoords.y);
        await sleep(40);
        await sendMouseEvent(tabId, 'mousePressed', fromCoords.x, fromCoords.y);
        await sleep(40);
        await sendMouseEvent(tabId, 'mouseReleased', fromCoords.x, fromCoords.y);

        // Delay between clicks to mimic humans
        await sleep(120);

        // Move to target square and click
        await sendMouseEvent(tabId, 'mouseMoved', toCoords.x, toCoords.y);
        await sleep(40);
        await sendMouseEvent(tabId, 'mousePressed', toCoords.x, toCoords.y);
        await sleep(40);
        await sendMouseEvent(tabId, 'mouseReleased', toCoords.x, toCoords.y);

        resolve();
      } catch (e) {
        reject(e);
      } finally {
        chrome.debugger.detach(target, () => {
          // Ignore errors during detach (e.g. if already detached or tab closed)
          const _ = chrome.runtime.lastError;
        });
      }
    });
  });
}

// Keep service worker alive
chrome.runtime.onInstalled.addListener(() => {
  console.log('[LichessBot] Extension installed/updated.');
});

// Message listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'performDebuggerMove') {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ success: false, error: 'No sender tab ID found' });
      return false;
    }

    performDebuggerMove(tabId, message.fromCoords, message.toCoords)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));

    return true; // Keep channel open for async response
  }

  // Relay messages from popup to content script
  if (message.target === 'content' || !sender.tab) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ error: 'No active tab' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });
    return true; // Keep channel open for async response
  }
});

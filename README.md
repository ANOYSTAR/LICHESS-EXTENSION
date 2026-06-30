# ♟ Lichess Stockfish Auto-Bot — Chrome Extension ( GREY TECHNOLOGY )

Automatically plays chess on **lichess.org** using the **Stockfish 16** engine at full strength.

---

## 📦 Files in This Folder

| File | Description |
|------|-------------|
| `manifest.json` | Extension config (MV3) |
| `content.js` | Core bot logic injected into Lichess |
| `background.js` | Service worker (message relay) |
| `popup.html` | Extension popup UI |
| `popup.js` | Popup controller |
| `stockfish.js` | Stockfish 16 chess engine (~1.5 MB) |
| `icons/` | Extension icons (16/48/128px) |

---

## 🚀 How to Install in Chrome

1. Open Chrome and go to: `chrome://extensions`
2. Turn on **Developer Mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select this folder: `New folder (2)`
5. The extension icon (♟) appears in the toolbar

---

## 🎮 How to Use

1. Go to **[lichess.org](https://lichess.org)**
2. Start or join a game (any time control)
3. Click the **♟ extension icon** in Chrome's toolbar
4. Click **▶ Start Bot**
5. The bot will automatically play moves for you!

### Settings
- **Search Depth**: Higher = stronger but slower (default: 20)
- **Move Delay**: Simulates human thinking time (default: 300ms)

### In-Page Overlay
A floating panel appears on the Lichess page with:
- Real-time evaluation bar
- Best move preview
- Start/Stop buttons
- Depth and delay sliders
- Move log

---

## ⚙️ Technical Details

- Uses **Lichess's internal game state** (`window.lichess.round`) to read the FEN position — more reliable than DOM scraping
- Falls back to DOM parsing if the internal API isn't available
- Uses **UCI protocol** to communicate with Stockfish
- Mouse events are simulated on the Lichess board canvas (`cg-board`)
- Works for **both colors** (auto-detects which side you're playing)

---

## ⚠️ Fair Play Notice

Using automated bots on Lichess **violates their Terms of Service** and can result in account bans. Use this tool only for:
- Personal practice
- Testing/development
- Analysis

---

## 🛠 Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot doesn't move | Make sure you're on a live game page (not analysis) |
| Engine not loading | Refresh the page and re-enable the bot |
| Moves wrong squares | Try refreshing; board orientation may need re-detection |
| Extension not showing | Check `chrome://extensions` — enable if disabled |



THIS EXTENSION IS MADE BY - GREY TECHNOLOGY by dhruvtara

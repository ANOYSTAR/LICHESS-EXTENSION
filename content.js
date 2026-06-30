// content.js - Lichess Stockfish Bot v3.0
// Supports Lichess Board API (token-based) + DOM fallback
// Arrow overlay shows best move direction on board

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════
  const BOT = {
    active: false,
    hintMode: false,
    color: null,        // 'white' | 'black'
    engine: null,
    engineReady: false,
    depth: 20,
    moveDelay: 300,
    lastFen: '',
    processing: false,
    tickInterval: null,
    moveHistory: [],
    lastArrowMove: '',

    // API mode
    apiToken: 'lip_tb5lvcPJw6H13bJiXglB',
    gameId: 'anoystar',
    useAPI: false,
    apiGameData: null,        // latest game state from API stream
    apiStream: null,        // EventSource / fetch reader
  };

  // ═══════════════════════════════════════════════════════════════
  // LICHESS BOARD API
  // ═══════════════════════════════════════════════════════════════

  function extractGameId() {
    // Matches /abcde1234 or /abcde1234/white or /abcde1234/black
    const m = window.location.pathname.match(/^\/([a-zA-Z0-9]{8,12})/);
    return m ? m[1] : null;
  }

  async function verifyToken(token) {
    try {
      const r = await fetch('https://lichess.org/api/account', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!r.ok) return null;
      const data = await r.json();
      return data.username || null;
    } catch (e) { return null; }
  }

  // Make a move using the Lichess Board API
  async function makeMoveViaAPI(move) {
    if (!BOT.apiToken || !BOT.gameId) return false;
    try {
      const r = await fetch(
        `https://lichess.org/api/board/game/${BOT.gameId}/move/${move}`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${BOT.apiToken}` }
        }
      );
      return r.ok;
    } catch (e) {
      log('API move error: ' + e.message, 'error');
      return false;
    }
  }

  // Stream current game via Board API (NDJSON stream)
  function startAPIStream() {
    if (BOT.apiStream) { try { BOT.apiStream.abort(); } catch (e) { } }
    if (!BOT.apiToken || !BOT.gameId) return;

    log(`Streaming game ${BOT.gameId} via API...`);

    const controller = new AbortController();
    BOT.apiStream = controller;

    fetch(`https://lichess.org/api/board/game/stream/${BOT.gameId}`, {
      headers: {
        'Authorization': `Bearer ${BOT.apiToken}`,
        'Accept': 'application/x-ndjson',
      },
      signal: controller.signal,
    }).then(async (resp) => {
      if (!resp.ok) { log('API stream failed: ' + resp.status, 'error'); return; }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed);
            handleAPIEvent(event);
          } catch (e) { }
        }
      }
    }).catch((e) => {
      if (e.name !== 'AbortError') log('Stream error: ' + e.message, 'warn');
    });
  }

  function handleAPIEvent(event) {
    // gameFull — sent once at start
    if (event.type === 'gameFull') {
      const white = event.white?.id || event.white?.name || '';
      const black = event.black?.id || event.black?.name || '';
      // Determine our color from account username
      chrome.storage.local.get(['apiUsername'], (d) => {
        const username = (d.apiUsername || '').toLowerCase();
        if (username) {
          BOT.color = white.toLowerCase() === username ? 'white' : 'black';
        } else {
          BOT.color = getBoardOrientation(); // fallback
        }
        log(`Playing as ${BOT.color} (API confirmed)`);
        updateOverlay({ type: 'COLOR', color: BOT.color });
      });

      // Process current state
      const state = event.state || {};
      BOT.apiGameData = {
        fen: buildFenFromMoves(state.moves || ''),
        moves: (state.moves || '').split(' ').filter(Boolean),
        status: state.status,
        wtime: state.wtime,
        btime: state.btime,
      };
      BOT.useAPI = true;
    }

    // gameState — incremental updates
    if (event.type === 'gameState') {
      const moves = (event.moves || '').split(' ').filter(Boolean);
      BOT.apiGameData = {
        fen: buildFenFromMoves(event.moves || ''),
        moves,
        status: event.status,
        wtime: event.wtime,
        btime: event.btime,
      };

      // If game ended
      if (['mate', 'resign', 'draw', 'timeout', 'outoftime', 'aborted', 'stalemate'].includes(event.status)) {
        log('Game over: ' + event.status);
        stopBot();
        updateOverlay({ type: 'STATUS', status: 'Game Over: ' + event.status, active: false });
        return;
      }

      // Trigger bot if active
      if (BOT.active && !BOT.processing) {
        botTick();
      }
    }

    // chatLine, opponentGone, etc — ignore
  }

  // Convert moves string to FEN via position startpos
  // We can't do this without a chess library in-browser,
  // so we feed moves to Stockfish's "position startpos moves ..." and read FEN back.
  // For now, use moves list directly in getBestMove()
  function buildFenFromMoves(movesStr) {
    // Return a sentinel; actual FEN will come from Stockfish via position startpos moves ...
    return 'startpos_with_moves:' + movesStr;
  }

  // ═══════════════════════════════════════════════════════════════
  // STOCKFISH ENGINE
  // ═══════════════════════════════════════════════════════════════
  let _resolveMove = null;

  function initEngine() {
    return new Promise(async (resolve, reject) => {
      try {
        log('Fetching Stockfish engine...');
        const sfUrl = chrome.runtime.getURL('stockfish.js');
        const wasmUrl = chrome.runtime.getURL('stockfish.wasm');

        const resp = await fetch(sfUrl);
        if (!resp.ok) throw new Error('fetch stockfish.js failed: ' + resp.status);
        const src = await resp.text();

        const header = `self._stockfishWasmUrl = ${JSON.stringify(wasmUrl)};\n`;
        const blob = new Blob([header + src], { type: 'application/javascript' });
        const blobUrl = URL.createObjectURL(blob);
        const worker = new Worker(blobUrl);
        BOT.engine = worker;

        let uciOk = false, readyOk = false;
        const t = setTimeout(() => reject(new Error('Engine timeout')), 20000);

        worker.onmessage = (e) => {
          const msg = typeof e.data === 'string' ? e.data : String(e.data);
          parseEngineOutput(msg);
          if (!uciOk && msg.includes('uciok')) {
            uciOk = true;
            worker.postMessage('setoption name Threads value 2');
            worker.postMessage('setoption name Hash value 128');
            worker.postMessage('setoption name Skill Level value 20');
            worker.postMessage('setoption name UCI_LimitStrength value false');
            worker.postMessage('isready');
          }
          if (!readyOk && msg.includes('readyok')) {
            readyOk = true;
            clearTimeout(t);
            BOT.engineReady = true;
            log('Engine ready! ✓');
            resolve(worker);
          }
        };
        worker.onerror = (err) => {
          log('Worker error: ' + (err.message || err), 'error');
          reject(new Error(err.message || 'Worker error'));
        };
        worker.postMessage('uci');
        log('Stockfish worker starting...');
      } catch (err) {
        log('Engine init failed: ' + err.message, 'error');
        reject(err);
      }
    });
  }

  function parseEngineOutput(msg) {
    if (msg.startsWith('bestmove')) {
      const mv = msg.split(' ')[1];
      if (mv && mv !== '(none)' && _resolveMove) {
        const r = _resolveMove; _resolveMove = null; r(mv);
      } else if (_resolveMove) {
        const r = _resolveMove; _resolveMove = null; r(null);
      }
    }
    if (msg.startsWith('info') && msg.includes('score')) {
      const scoreM = msg.match(/score (cp|mate) (-?\d+)/);
      const depthM = msg.match(/depth (\d+)/);
      const pvM = msg.match(/ pv (.+)/);
      if (scoreM) {
        let ev = scoreM[1] === 'cp'
          ? (parseInt(scoreM[2]) / 100).toFixed(2)
          : 'M' + scoreM[2];
        if (BOT.color === 'black' && scoreM[1] === 'cp')
          ev = (-parseInt(scoreM[2]) / 100).toFixed(2);
        updateOverlay({
          type: 'EVAL', eval: ev,
          depth: depthM ? depthM[1] : '',
          pv: pvM ? pvM[1].split(' ').slice(0, 3).join(' ') : ''
        });
      }
    }
  }

  function getBestMove(fenOrMoves, movesArr) {
    return new Promise((resolve) => {
      if (!BOT.engine || !BOT.engineReady) { resolve(null); return; }
      _resolveMove = resolve;
      BOT.engine.postMessage('ucinewgame');

      if (movesArr && movesArr.length > 0) {
        // Most reliable: feed full moves list from start position
        BOT.engine.postMessage(`position startpos moves ${movesArr.join(' ')}`);
      } else if (fenOrMoves && fenOrMoves.startsWith('startpos_with_moves:')) {
        const moves = fenOrMoves.slice('startpos_with_moves:'.length).trim();
        BOT.engine.postMessage(moves
          ? `position startpos moves ${moves}`
          : 'position startpos');
      } else if (fenOrMoves) {
        BOT.engine.postMessage(`position fen ${fenOrMoves}`);
      } else {
        BOT.engine.postMessage('position startpos');
      }

      BOT.engine.postMessage(`go depth ${BOT.depth}`);
      setTimeout(() => { if (_resolveMove) BOT.engine.postMessage('stop'); }, 12000);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GAME STATE (DOM fallback when no API token)
  // ═══════════════════════════════════════════════════════════════

  function getLichessGameData() {
    // If API has fresh data, use it
    if (BOT.useAPI && BOT.apiGameData) return BOT.apiGameData;

    // Method 1: lichess.round internal object
    try {
      if (window.lichess?.round) {
        const r = window.lichess.round;
        const data = r.data || (r.vm && r.vm.data);
        if (data) {
          const steps = data.steps || data.game?.steps;
          const lastStep = steps && steps[steps.length - 1];
          const fen = lastStep?.fen || data.game?.fen;
          const color = data.game?.player?.color || data.player?.color;
          const moves = steps ? steps.filter(s => s.uci).map(s => s.uci) : null;
          if (fen) return { fen, moves, turn: fen.split(' ')[1], color: color || 'white' };
        }
      }
    } catch (e) { }

    // Method 2: analysis tree
    try {
      if (window.lichess?.analysis) {
        const a = window.lichess.analysis;
        const node = a.tree?.main;
        if (node) {
          return {
            fen: node.fen, moves: null,
            turn: node.fen.split(' ')[1],
            color: a.data?.game?.player?.color || a.orientation || 'white'
          };
        }
      }
    } catch (e) { }

    // Method 3: data-fen attribute
    try {
      const el = document.querySelector('[data-fen]');
      if (el) {
        const fen = el.getAttribute('data-fen');
        const color = el.getAttribute('data-color') || 'white';
        return { fen, moves: null, turn: fen.split(' ')[1], color };
      }
    } catch (e) { }

    // Method 4: Parse board DOM
    return parseBoardFromDOM();
  }

  function parseBoardFromDOM() {
    const board = document.querySelector('cg-board');
    if (!board) return null;
    const orientation = getBoardOrientation();
    const pieces = board.querySelectorAll('piece');
    const rect = board.getBoundingClientRect();
    const sq = rect.width / 8;
    const grid = {};

    for (const piece of pieces) {
      const style = piece.getAttribute('style') || '';
      const cls = piece.getAttribute('class') || '';
      const m = style.match(/translate\(([\d.]+)px,\s*([\d.]+)px\)/);
      if (!m) continue;
      const px = parseFloat(m[1]);
      const py = parseFloat(m[2]);
      let file = Math.round(px / sq);
      let rank = 7 - Math.round(py / sq);
      file = Math.max(0, Math.min(7, file));
      rank = Math.max(0, Math.min(7, rank));

      let color = cls.includes('white') ? 'w' : cls.includes('black') ? 'b' : null;
      let type = null;
      if (cls.includes('pawn')) type = 'p';
      else if (cls.includes('rook')) type = 'r';
      else if (cls.includes('knight')) type = 'n';
      else if (cls.includes('bishop')) type = 'b';
      else if (cls.includes('queen')) type = 'q';
      else if (cls.includes('king')) type = 'k';

      if (color && type) {
        const code = color === 'w' ? type.toUpperCase() : type;
        grid[`${file},${rank}`] = code;
      }
    }

    const fen = gridToFEN(grid, orientation);
    const turn = detectTurnFromDOM();
    return { fen: fen + ' ' + turn + ' KQkq - 0 1', moves: null, turn, color: orientation };
  }

  function gridToFEN(grid, orientation) {
    let fen = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const piece = grid[`${f},${r}`];
        if (piece) {
          if (empty) { fen += empty; empty = 0; }
          fen += piece;
        } else { empty++; }
      }
      if (empty) fen += empty;
      if (r > 0) fen += '/';
    }
    return fen;
  }

  function getBoardOrientation() {
    const cgWrap = document.querySelector('.cg-wrap');
    if (cgWrap) {
      if (cgWrap.classList.contains('orientation-black')) return 'black';
      if (cgWrap.classList.contains('orientation-white')) return 'white';
    }
    try {
      const c = window.lichess?.round?.data?.player?.color
        || window.lichess?.analysis?.orientation;
      if (c) return c;
    } catch (e) { }
    return 'white';
  }

  function detectTurnFromDOM() {
    if (document.querySelector('.rclock-white.rclock-turn')) return 'w';
    if (document.querySelector('.rclock-black.rclock-turn')) return 'b';
    return 'w';
  }

  // ═══════════════════════════════════════════════════════════════
  // TURN DETECTION
  // ═══════════════════════════════════════════════════════════════

  function isMyTurn(gameData) {
    if (!BOT.color) return false;
    const mine = BOT.color === 'white' ? 'w' : 'b';

    // API mode: use number of moves played
    if (BOT.useAPI && BOT.apiGameData?.moves) {
      const moveCount = BOT.apiGameData.moves.length;
      // White plays on even moves (0,2,4...), black on odd (1,3,5...)
      const expectedColor = moveCount % 2 === 0 ? 'white' : 'black';
      return BOT.color === expectedColor;
    }

    // DOM mode: check FEN turn
    if (gameData?.fen && !gameData.fen.startsWith('startpos')) {
      const fenTurn = gameData.fen.split(' ')[1];
      if (fenTurn && fenTurn !== mine) return false;
    }

    // Clock highlight
    const oppClock = BOT.color === 'white' ? '.rclock-black.rclock-turn' : '.rclock-white.rclock-turn';
    if (document.querySelector(oppClock)) return false;

    return true;
  }

  function isGameActive() {
    const overSelectors = ['.game__result', '.result-wrap', '.game-over'];
    for (const s of overSelectors) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) return false;
    }
    return !!document.querySelector('cg-board');
  }

  // ═══════════════════════════════════════════════════════════════
  // MOVE EXECUTION
  // ═══════════════════════════════════════════════════════════════

  function algebraicToCoords(sq) {
    return { file: 'abcdefgh'.indexOf(sq[0]), rank: parseInt(sq[1]) - 1 };
  }

  async function executeMove(uciMove) {
    // API mode: use Board API
    if (BOT.useAPI && BOT.apiToken && BOT.gameId) {
      log(`API move: ${uciMove}`);
      const ok = await makeMoveViaAPI(uciMove);
      if (ok) { log(`Move ${uciMove} sent via API ✓`, 'move'); return true; }
      log('API move failed, trying DOM...', 'warn');
    }

    // DOM mode: simulate mouse clicks
    return executeMoveDOM(uciMove);
  }

  async function executeMoveDOM(uciMove) {
    const from = algebraicToCoords(uciMove.slice(0, 2));
    const to = algebraicToCoords(uciMove.slice(2, 4));
    const promo = uciMove.length > 4 ? uciMove[4] : null;

    const board = document.querySelector('cg-board');
    if (!board) return false;

    const orientation = BOT.color || 'white';
    const rect = board.getBoundingClientRect();
    const sq = rect.width / 8;

    function toPx(coords) {
      const x = orientation === 'white'
        ? coords.file * sq + sq / 2
        : (7 - coords.file) * sq + sq / 2;
      const y = orientation === 'white'
        ? (7 - coords.rank) * sq + sq / 2
        : coords.rank * sq + sq / 2;
      return { x: rect.left + x, y: rect.top + y };
    }

    const fp = toPx(from);
    const tp = toPx(to);

    await sleep(BOT.moveDelay + Math.random() * 100);

    log(`Attempting CDP move: ${uciMove}`);

    const success = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'performDebuggerMove',
        fromCoords: fp,
        toCoords: tp
      }, (response) => {
        if (chrome.runtime.lastError) {
          log(`Debugger message error: ${chrome.runtime.lastError.message}`, 'warn');
          resolve(false);
        } else if (response && response.success) {
          resolve(true);
        } else {
          log(`Debugger execution failed: ${response?.error || 'Unknown error'}`, 'warn');
          resolve(false);
        }
      });
    });

    if (success) {
      log(`CDP move successful: ${uciMove}`, 'move');
    } else {
      log(`Falling back to standard DOM clicks: ${uciMove}`, 'warn');
      fireClick(board, fp.x, fp.y);
      await sleep(60 + Math.random() * 50);
      fireClick(board, tp.x, tp.y);
    }

    if (promo) {
      await sleep(350);
      const promoMap = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight' };
      const pName = promoMap[promo] || 'queen';
      const promoEl = document.querySelector(
        `.promotion-choice piece.${orientation}.${pName},` +
        `cg-promotion piece.${orientation}.${pName},[data-role="${promo}"]`
      );
      if (promoEl) promoEl.click();
    }
    return true;
  }

  function fireClick(el, x, y) {
    ['mousedown', 'mouseup', 'click'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, {
        bubbles: true, cancelable: true, view: window,
        clientX: x, clientY: y, screenX: x, screenY: y,
        button: 0, buttons: t === 'mousedown' ? 1 : 0,
      }))
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // ARROW VISUALISER  (fixed: uses getBoundingClientRect always)
  // ═══════════════════════════════════════════════════════════════

  function drawMoveArrow(uciMove) {
    if (!uciMove || uciMove.length < 4) return;
    clearMoveArrow();

    const board = document.querySelector('cg-board');
    if (!board) return;

    // Always use getBoundingClientRect for reliable pixel dimensions
    const boardRect = board.getBoundingClientRect();
    const boardW = boardRect.width;
    const boardH = boardRect.height;
    if (!boardW || !boardH) return;  // board not rendered yet

    const sq = boardW / 8;
    const orientation = BOT.color || getBoardOrientation();
    const from = algebraicToCoords(uciMove.slice(0, 2));
    const to = algebraicToCoords(uciMove.slice(2, 4));

    function centre(coords) {
      // Convert chess coords → pixel centre of square (relative to board top-left)
      let x, y;
      if (orientation === 'white') {
        x = coords.file * sq + sq / 2;
        y = (7 - coords.rank) * sq + sq / 2;
      } else {
        x = (7 - coords.file) * sq + sq / 2;
        y = coords.rank * sq + sq / 2;
      }
      return { x, y };
    }

    const fp = centre(from);
    const tp = centre(to);
    const dx = tp.x - fp.x;
    const dy = tp.y - fp.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const shortBy = sq * 0.28;
    const ratio = (len - shortBy) / len;
    const ex = fp.x + dx * ratio;
    const ey = fp.y + dy * ratio;

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.id = 'sf-arrow-svg';
    svg.setAttribute('viewBox', `0 0 ${boardW} ${boardH}`);
    svg.style.cssText = `position:absolute;width:${boardW}px;height:${boardH}px;pointer-events:none;z-index:500;overflow:visible;`;

    // ── Defs ──
    const defs = document.createElementNS(NS, 'defs');

    const mkr = document.createElementNS(NS, 'marker');
    mkr.setAttribute('id', 'sf-ah'); mkr.setAttribute('markerWidth', '6');
    mkr.setAttribute('markerHeight', '6'); mkr.setAttribute('refX', '3');
    mkr.setAttribute('refY', '3'); mkr.setAttribute('orient', 'auto');
    mkr.setAttribute('markerUnits', 'strokeWidth');
    const mp = document.createElementNS(NS, 'path');
    mp.setAttribute('d', 'M0,0 L0,6 L6,3 z'); mp.setAttribute('fill', '#f7c948');
    mkr.appendChild(mp);

    const flt = document.createElementNS(NS, 'filter');
    flt.setAttribute('id', 'sf-glow'); flt.setAttribute('x', '-60%'); flt.setAttribute('y', '-60%');
    flt.setAttribute('width', '220%'); flt.setAttribute('height', '220%');
    const fb = document.createElementNS(NS, 'feGaussianBlur');
    fb.setAttribute('stdDeviation', '4'); fb.setAttribute('result', 'blur');
    const fm = document.createElementNS(NS, 'feMerge');
    const n1 = document.createElementNS(NS, 'feMergeNode'); n1.setAttribute('in', 'blur');
    const n2 = document.createElementNS(NS, 'feMergeNode'); n2.setAttribute('in', 'SourceGraphic');
    fm.appendChild(n1); fm.appendChild(n2);
    flt.appendChild(fb); flt.appendChild(fm);
    defs.appendChild(mkr); defs.appendChild(flt);
    svg.appendChild(defs);

    // ── FROM square: full square highlight (cyan) ──
    const fromSq = document.createElementNS(NS, 'rect');
    fromSq.setAttribute('x', from.file === -1 ? 0 : centre(from).x - sq / 2);
    fromSq.setAttribute('y', centre(from).y - sq / 2);
    fromSq.setAttribute('width', sq); fromSq.setAttribute('height', sq);
    fromSq.setAttribute('fill', 'rgba(79,195,247,0.30)');
    fromSq.setAttribute('stroke', '#4fc3f7'); fromSq.setAttribute('stroke-width', sq * 0.06);
    fromSq.innerHTML = `<animate attributeName="opacity" values="1;0.55;1" dur="0.9s" repeatCount="indefinite"/>`;
    svg.appendChild(fromSq);

    // ── FROM: pulsing ring ──
    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', fp.x); ring.setAttribute('cy', fp.y);
    ring.setAttribute('r', sq * 0.38); ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', '#4fc3f7'); ring.setAttribute('stroke-width', sq * 0.08);
    ring.setAttribute('filter', 'url(#sf-glow)');
    ring.innerHTML = `<animate attributeName="r" values="${sq * 0.34};${sq * 0.44};${sq * 0.34}" dur="0.9s" repeatCount="indefinite"/>`;
    svg.appendChild(ring);

    // ── TO square: gold highlight ──
    const toSq = document.createElementNS(NS, 'rect');
    toSq.setAttribute('x', tp.x - sq / 2); toSq.setAttribute('y', tp.y - sq / 2);
    toSq.setAttribute('width', sq); toSq.setAttribute('height', sq);
    toSq.setAttribute('fill', 'rgba(247,201,72,0.35)');
    toSq.setAttribute('stroke', '#f7c948'); toSq.setAttribute('stroke-width', sq * 0.06);
    toSq.setAttribute('filter', 'url(#sf-glow)');
    toSq.innerHTML = `<animate attributeName="opacity" values="1;0.5;1" dur="0.9s" repeatCount="indefinite"/>`;
    svg.appendChild(toSq);

    // ── Arrow glow shadow ──
    const shadow = document.createElementNS(NS, 'line');
    shadow.setAttribute('x1', fp.x); shadow.setAttribute('y1', fp.y);
    shadow.setAttribute('x2', ex); shadow.setAttribute('y2', ey);
    shadow.setAttribute('stroke', '#f7c948'); shadow.setAttribute('stroke-width', sq * 0.26);
    shadow.setAttribute('stroke-linecap', 'round'); shadow.setAttribute('opacity', '0.2');
    svg.appendChild(shadow);

    // ── Arrow shaft ──
    const shaft = document.createElementNS(NS, 'line');
    shaft.setAttribute('x1', fp.x); shaft.setAttribute('y1', fp.y);
    shaft.setAttribute('x2', ex); shaft.setAttribute('y2', ey);
    shaft.setAttribute('stroke', '#f7c948'); shaft.setAttribute('stroke-width', sq * 0.14);
    shaft.setAttribute('stroke-linecap', 'round'); shaft.setAttribute('opacity', '0.95');
    shaft.setAttribute('marker-end', 'url(#sf-ah)'); shaft.setAttribute('filter', 'url(#sf-glow)');
    svg.appendChild(shaft);

    // ── Move label badge ──
    const angle = Math.atan2(dy, dx);
    const midX = (fp.x + tp.x) / 2 + Math.sin(angle) * sq * 0.45;
    const midY = (fp.y + tp.y) / 2 - Math.cos(angle) * sq * 0.45;
    const fz = Math.max(11, sq * 0.2);
    const txt = uciMove.slice(0, 2) + '→' + uciMove.slice(2, 4);

    const bgR = document.createElementNS(NS, 'rect');
    bgR.setAttribute('x', midX - fz * 1.9); bgR.setAttribute('y', midY - fz * 0.85);
    bgR.setAttribute('width', fz * 3.8); bgR.setAttribute('height', fz * 1.6);
    bgR.setAttribute('rx', 5); bgR.setAttribute('fill', 'rgba(0,0,0,0.78)');
    bgR.setAttribute('stroke', 'rgba(247,201,72,0.5)'); bgR.setAttribute('stroke-width', '1');
    svg.appendChild(bgR);

    const txtEl = document.createElementNS(NS, 'text');
    txtEl.setAttribute('x', midX); txtEl.setAttribute('y', midY + fz * 0.38);
    txtEl.setAttribute('text-anchor', 'middle');
    txtEl.setAttribute('font-family', 'Consolas,monospace,sans-serif');
    txtEl.setAttribute('font-size', fz); txtEl.setAttribute('font-weight', 'bold');
    txtEl.setAttribute('fill', '#f7c948');
    txtEl.textContent = txt;
    svg.appendChild(txtEl);

    // ── Mount on cg-container (NEVER modify cg-board) ──
    const container = document.querySelector('cg-container') || board.parentElement;
    if (!container) return;

    const cRect = container.getBoundingClientRect();
    svg.style.left = (boardRect.left - cRect.left) + 'px';
    svg.style.top = (boardRect.top - cRect.top) + 'px';
    container.appendChild(svg);

    BOT.lastArrowMove = uciMove;
    log(`Arrow: ${uciMove.slice(0, 2)} → ${uciMove.slice(2, 4)}`, 'move');
  }

  function clearMoveArrow() {
    const svg = document.getElementById('sf-arrow-svg');
    if (svg) svg.remove();
    BOT.lastArrowMove = '';
  }

  // ═══════════════════════════════════════════════════════════════
  // BOT MAIN LOOP
  // ═══════════════════════════════════════════════════════════════

  async function botTick() {
    if (!BOT.active || BOT.processing) return;
    if (!BOT.engineReady) return;

    if (!isGameActive()) {
      stopBot(); updateOverlay({ type: 'STATUS', status: 'Game Over', active: false }); return;
    }

    const gameData = getLichessGameData();
    if (!gameData) { log('No game data'); return; }

    // Sync color
    if (!BOT.color) {
      BOT.color = gameData.color || getBoardOrientation();
      updateOverlay({ type: 'COLOR', color: BOT.color });
    }

    if (!isMyTurn(gameData)) return;

    // Check FEN changed (skip if same position)
    const fenKey = BOT.useAPI
      ? (BOT.apiGameData?.moves?.length ?? 0).toString()
      : gameData.fen;
    if (fenKey === BOT.lastFen) return;
    BOT.lastFen = fenKey;
    BOT.processing = true;

    try {
      updateOverlay({ type: 'STATUS', status: 'Thinking...', active: true });

      const movesArr = BOT.useAPI ? (BOT.apiGameData?.moves || []) : (gameData.moves || []);
      const bestMove = await getBestMove(gameData.fen, movesArr);

      if (bestMove && BOT.active) {
        BOT.moveHistory.push(bestMove);
        updateOverlay({ type: 'MOVE', move: bestMove });
        drawMoveArrow(bestMove);

        if (BOT.hintMode) {
          updateOverlay({ type: 'STATUS', status: `Hint: ${bestMove}`, active: true });
          setTimeout(clearMoveArrow, 5000);
        } else {
          await sleep(Math.max(150, BOT.moveDelay * 0.4));
          clearMoveArrow();
          const ok = await executeMove(bestMove);
          if (ok) updateOverlay({ type: 'STATUS', status: `Played: ${bestMove}`, active: true });
        }
      } else {
        log('No move from engine', 'warn');
        updateOverlay({ type: 'STATUS', status: 'No move found', active: true });
      }
    } catch (err) {
      log('Bot tick error: ' + err.message, 'error');
    } finally {
      BOT.processing = false;
    }
  }

  function startBot() {
    if (BOT.tickInterval) clearInterval(BOT.tickInterval);
    BOT.active = true;
    BOT.processing = false;
    BOT.lastFen = '';
    BOT.moveHistory = [];

    // Detect game ID and start API stream if token available
    BOT.gameId = extractGameId() || '';
    if (BOT.apiToken && BOT.gameId) {
      log(`API mode: game ${BOT.gameId}`);
      startAPIStream();
    } else {
      BOT.useAPI = false;
    }

    // Detect color from DOM
    const gd = getLichessGameData();
    BOT.color = gd?.color || getBoardOrientation();

    BOT.tickInterval = setInterval(botTick, 700);
    log('Bot STARTED — ' + (BOT.useAPI ? 'API mode' : 'DOM mode'));
    updateOverlay({ type: 'STATUS', status: BOT.useAPI ? 'Active (API)' : 'Active (DOM)', active: true });
    updateOverlay({ type: 'COLOR', color: BOT.color });
    updateOverlay({ type: 'API', active: BOT.useAPI });
  }

  function stopBot() {
    BOT.active = false;
    BOT.processing = false;
    if (BOT.tickInterval) { clearInterval(BOT.tickInterval); BOT.tickInterval = null; }
    if (BOT.engine) BOT.engine.postMessage('stop');
    if (BOT.apiStream) { try { BOT.apiStream.abort(); } catch (e) { } BOT.apiStream = null; }
    clearMoveArrow();
    log('Bot STOPPED.');
    updateOverlay({ type: 'STATUS', status: 'Stopped', active: false });
  }

  // ═══════════════════════════════════════════════════════════════
  // IN-PAGE OVERLAY UI
  // ═══════════════════════════════════════════════════════════════

  function createOverlay() {
    if (document.getElementById('sf-bot-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'sf-bot-overlay';
    overlay.innerHTML = `
      <div id="sfb-header">
        <span id="sfb-icon">♟</span>
        <span id="sfb-title">Stockfish Bot</span>
        <button id="sfb-minimize" title="Minimize">─</button>
      </div>
      <div id="sfb-body">
        <div id="sfb-api-badge">⚡ API Mode OFF</div>
        <div id="sfb-status-row">
          <span id="sfb-dot"></span>
          <span id="sfb-status-text">Idle</span>
        </div>
        <div class="sfb-info-row">
          <div class="sfb-info-cell">
            <div class="sfb-info-label">Eval</div>
            <div class="sfb-info-val" id="sfb-eval">—</div>
          </div>
          <div class="sfb-info-cell">
            <div class="sfb-info-label">Depth</div>
            <div class="sfb-info-val" id="sfb-depth">—</div>
          </div>
          <div class="sfb-info-cell">
            <div class="sfb-info-label">Color</div>
            <div class="sfb-info-val" id="sfb-color">—</div>
          </div>
        </div>
        <div id="sfb-last-move">Last: <span id="sfb-move-val">—</span></div>
        <div id="sfb-pv">PV: <span id="sfb-pv-val">—</span></div>
        <div id="sfb-controls">
          <button id="sfb-start">▶ AUTO</button>
          <button id="sfb-stop">■ STOP</button>
        </div>
        <div id="sfb-hint-row">
          <button id="sfb-hint">💡 HINT</button>
          <button id="sfb-arrow-clear">✕ Clear</button>
        </div>
        <div class="sfb-slider-group">
          <div class="sfb-slider-label">
            <span>Depth</span><span id="sfb-depth-val">20</span>
          </div>
          <input type="range" id="sfb-depth-slider" min="5" max="30" value="20">
        </div>
        <div class="sfb-slider-group">
          <div class="sfb-slider-label">
            <span>Delay</span><span id="sfb-delay-val">300ms</span>
          </div>
          <input type="range" id="sfb-delay-slider" min="0" max="3000" step="50" value="300">
        </div>
        <div id="sfb-log-box"><div id="sfb-log-content"></div></div>
      </div>
    `;

    document.body.appendChild(overlay);
    injectOverlayCSS();
    bindOverlayEvents(overlay);
    makeDraggable(overlay, document.getElementById('sfb-header'));
  }

  function injectOverlayCSS() {
    if (document.getElementById('sfb-styles')) return;
    const style = document.createElement('style');
    style.id = 'sfb-styles';
    style.textContent = `
      #sf-bot-overlay {
        position: fixed; top: 70px; right: 16px; width: 235px;
        background: linear-gradient(160deg,#0d1117 0%,#161b22 60%,#0f1f38 100%);
        border: 1px solid rgba(88,166,255,0.25); border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06);
        font-family: 'Segoe UI',system-ui,-apple-system,sans-serif;
        color: #c9d1d9; z-index: 2147483647; font-size: 12px; user-select: none;
      }
      #sf-bot-overlay.minimized #sfb-body { display:none; }
      #sfb-header {
        display:flex; align-items:center; gap:8px; padding:10px 12px;
        border-bottom:1px solid rgba(255,255,255,0.07); cursor:move;
        border-radius:14px 14px 0 0; background:rgba(88,166,255,0.05);
      }
      #sfb-icon { font-size:18px; }
      #sfb-title {
        flex:1; font-weight:800; font-size:13px;
        background:linear-gradient(90deg,#58a6ff,#bc8cff);
        -webkit-background-clip:text; -webkit-text-fill-color:transparent;
      }
      #sfb-minimize {
        background:none; border:none; color:#6e7681; cursor:pointer;
        font-size:14px; padding:2px 4px; border-radius:4px; transition:0.15s;
      }
      #sfb-minimize:hover { color:#c9d1d9; background:rgba(255,255,255,0.08); }
      #sfb-body { padding:10px 12px; display:flex; flex-direction:column; gap:7px; }
      #sfb-api-badge {
        text-align:center; font-size:10px; font-weight:700; letter-spacing:0.5px;
        padding:4px 8px; border-radius:6px;
        background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
        color:#484f58; transition:0.3s;
      }
      #sf-bot-overlay.api-active #sfb-api-badge {
        background:rgba(63,185,80,0.12); border-color:rgba(63,185,80,0.35);
        color:#3fb950;
      }
      #sfb-status-row {
        display:flex; align-items:center; gap:8px; padding:6px 10px;
        background:rgba(255,255,255,0.03); border-radius:8px;
        border:1px solid rgba(255,255,255,0.06);
      }
      #sfb-dot {
        width:9px; height:9px; border-radius:50%; background:#484f58; flex-shrink:0; transition:0.3s;
      }
      #sf-bot-overlay.active #sfb-dot {
        background:#3fb950; box-shadow:0 0 10px rgba(63,185,80,0.8);
        animation:sfb-pulse 1.4s ease-in-out infinite;
      }
      @keyframes sfb-pulse {
        0%,100% { box-shadow:0 0 6px rgba(63,185,80,0.8); }
        50% { box-shadow:0 0 16px rgba(63,185,80,1); }
      }
      #sfb-status-text { font-size:12px; font-weight:600; color:#8b949e; }
      #sf-bot-overlay.active #sfb-status-text { color:#3fb950; }
      .sfb-info-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:5px; }
      .sfb-info-cell {
        background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06);
        border-radius:7px; padding:5px; text-align:center;
      }
      .sfb-info-label { font-size:9px; color:#6e7681; text-transform:uppercase; letter-spacing:0.5px; margin-bottom:2px; }
      .sfb-info-val { font-size:13px; font-weight:700; color:#58a6ff; }
      #sfb-last-move,#sfb-pv { font-size:11px; color:#6e7681; }
      #sfb-move-val { color:#79c0ff; font-weight:700; }
      #sfb-pv-val { color:#8b949e; font-family:monospace; }
      #sfb-controls,#sfb-hint-row { display:flex; gap:6px; }
      #sfb-controls button, #sfb-hint-row button {
        flex:1; border:none; border-radius:8px; cursor:pointer;
        font-weight:800; letter-spacing:0.4px; transition:all 0.15s;
      }
      #sfb-controls button { padding:8px 4px; font-size:11px; }
      #sfb-start { background:linear-gradient(135deg,#1a7f37,#3fb950); color:#fff; box-shadow:0 2px 12px rgba(63,185,80,0.3); }
      #sfb-start:hover { background:linear-gradient(135deg,#238636,#56d364); transform:translateY(-1px); }
      #sfb-stop  { background:linear-gradient(135deg,#6e1a1a,#da3633); color:#fff; box-shadow:0 2px 12px rgba(218,54,51,0.3); }
      #sfb-stop:hover  { background:linear-gradient(135deg,#b91c1c,#f85149); transform:translateY(-1px); }
      #sfb-hint { padding:7px 4px; font-size:10px; background:linear-gradient(135deg,#3d1a52,#7b2d8b); color:#e8d5ff; box-shadow:0 2px 10px rgba(123,45,139,0.35); }
      #sfb-hint:hover { background:linear-gradient(135deg,#5c2878,#9c4dbf); transform:translateY(-1px); }
      #sfb-hint.on { background:linear-gradient(135deg,#7b2d8b,#bc8cff); box-shadow:0 0 14px rgba(188,140,255,0.7); }
      #sfb-arrow-clear { padding:7px 8px; font-size:10px; font-weight:700; background:rgba(255,255,255,0.06); color:#8b949e; border:1px solid rgba(255,255,255,0.1); }
      #sfb-arrow-clear:hover { color:#c9d1d9; background:rgba(255,255,255,0.12); }
      .sfb-slider-group { display:flex; flex-direction:column; gap:3px; }
      .sfb-slider-label { display:flex; justify-content:space-between; font-size:10px; color:#6e7681; font-weight:600; text-transform:uppercase; }
      .sfb-slider-label span:last-child { color:#58a6ff; }
      input[type="range"] { width:100%; height:3px; appearance:none; background:#21262d; border-radius:2px; outline:none; }
      input[type="range"]::-webkit-slider-thumb { appearance:none; width:13px; height:13px; border-radius:50%; background:#58a6ff; cursor:pointer; box-shadow:0 0 6px rgba(88,166,255,0.6); transition:0.15s; }
      input[type="range"]::-webkit-slider-thumb:hover { transform:scale(1.3); }
      #sfb-log-box { background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:5px 7px; max-height:65px; overflow-y:auto; font-family:monospace; font-size:10px; line-height:1.5; }
      #sfb-log-box::-webkit-scrollbar { width:3px; }
      #sfb-log-box::-webkit-scrollbar-thumb { background:#30363d; border-radius:2px; }
      .sfb-log-line.info  { color:#58a6ff; }
      .sfb-log-line.warn  { color:#d29922; }
      .sfb-log-line.error { color:#f85149; }
      .sfb-log-line.move  { color:#3fb950; font-weight:bold; }
      .sfb-log-line       { color:#6e7681; }
    `;
    document.head.appendChild(style);
  }

  function bindOverlayEvents(overlay) {
    // AUTO (play moves)
    document.getElementById('sfb-start').addEventListener('click', async () => {
      BOT.hintMode = false;
      document.getElementById('sfb-hint').classList.remove('on');
      document.getElementById('sfb-hint').textContent = '💡 HINT';
      if (!BOT.engine) {
        updateOverlay({ type: 'STATUS', status: 'Loading engine...', active: false });
        try { await initEngine(); startBot(); }
        catch (e) { updateOverlay({ type: 'STATUS', status: '⚠ Engine failed!', active: false }); log(e.message, 'error'); }
      } else { startBot(); }
    });

    // STOP
    document.getElementById('sfb-stop').addEventListener('click', () => {
      stopBot();
      document.getElementById('sfb-hint').classList.remove('on');
      document.getElementById('sfb-hint').textContent = '💡 HINT';
    });

    // HINT MODE (arrow only)
    document.getElementById('sfb-hint').addEventListener('click', async () => {
      BOT.hintMode = true;
      const btn = document.getElementById('sfb-hint');
      btn.classList.add('on'); btn.textContent = '💡 Hint ON';
      if (!BOT.engine) {
        updateOverlay({ type: 'STATUS', status: 'Loading engine...', active: false });
        try { await initEngine(); }
        catch (e) { updateOverlay({ type: 'STATUS', status: '⚠ Engine failed!', active: false }); log(e.message, 'error'); return; }
      }
      if (!BOT.active) startBot();
      log('Hint mode ON — shows arrow, no auto-play', 'info');
    });

    // Clear arrow
    document.getElementById('sfb-arrow-clear').addEventListener('click', () => {
      clearMoveArrow(); log('Arrow cleared');
    });

    // Depth slider
    document.getElementById('sfb-depth-slider').addEventListener('input', (e) => {
      BOT.depth = parseInt(e.target.value);
      document.getElementById('sfb-depth-val').textContent = e.target.value;
    });

    // Delay slider
    document.getElementById('sfb-delay-slider').addEventListener('input', (e) => {
      BOT.moveDelay = parseInt(e.target.value);
      document.getElementById('sfb-delay-val').textContent = e.target.value + 'ms';
    });

    // Minimize
    document.getElementById('sfb-minimize').addEventListener('click', () => {
      overlay.classList.toggle('minimized');
    });
  }

  function updateOverlay(data) {
    const overlay = document.getElementById('sf-bot-overlay');
    if (!overlay) return;
    if (data.type === 'STATUS') {
      const el = document.getElementById('sfb-status-text');
      if (el) el.textContent = data.status;
      if (typeof data.active === 'boolean') overlay.classList.toggle('active', data.active);
    }
    if (data.type === 'EVAL') {
      const e = document.getElementById('sfb-eval');
      const d = document.getElementById('sfb-depth');
      const p = document.getElementById('sfb-pv-val');
      if (e) e.textContent = data.eval || '—';
      if (d) d.textContent = data.depth || '—';
      if (p && data.pv) p.textContent = data.pv;
    }
    if (data.type === 'MOVE') {
      const el = document.getElementById('sfb-move-val');
      if (el) el.textContent = data.move || '—';
    }
    if (data.type === 'COLOR') {
      const el = document.getElementById('sfb-color');
      if (el) el.textContent = data.color
        ? data.color.charAt(0).toUpperCase() + data.color.slice(1) : '—';
    }
    if (data.type === 'API') {
      const badge = document.getElementById('sfb-api-badge');
      if (badge) badge.textContent = data.active ? '⚡ API Mode ON' : '⚡ API Mode OFF';
      overlay.classList.toggle('api-active', !!data.active);
    }
  }

  function log(msg, level = 'info') {
    const el = document.getElementById('sfb-log-content');
    if (el) {
      const line = document.createElement('div');
      line.className = `sfb-log-line ${level}`;
      line.textContent = msg;
      el.appendChild(line);
      while (el.children.length > 25) el.removeChild(el.firstChild);
      el.parentElement.scrollTop = el.parentElement.scrollHeight;
    }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[SFBot]', msg);
  }

  function makeDraggable(el, handle) {
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      const r = el.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top = (e.clientY - oy) + 'px';
      el.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ═══════════════════════════════════════════════════════════════
  // POPUP MESSAGE LISTENER
  // ═══════════════════════════════════════════════════════════════

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'START_BOT') {
      BOT.hintMode = false;
      if (!BOT.engine) {
        initEngine().then(() => { startBot(); sendResponse({ success: true }); })
          .catch(() => sendResponse({ success: false }));
        return true;
      } else { startBot(); sendResponse({ success: true }); }
    }
    if (msg.type === 'STOP_BOT') { stopBot(); sendResponse({ success: true }); }
    if (msg.type === 'GET_STATUS') {
      sendResponse({
        active: BOT.active, color: BOT.color, engineReady: BOT.engineReady,
        moves: BOT.moveHistory.length, useAPI: BOT.useAPI,
        apiToken: BOT.apiToken ? '✓ Set' : 'Not set',
      });
    }
    if (msg.type === 'SET_DEPTH') { BOT.depth = msg.depth; sendResponse({ success: true }); }
    if (msg.type === 'SET_DELAY') { BOT.moveDelay = msg.delay; sendResponse({ success: true }); }
    if (msg.type === 'SET_TOKEN') {
      BOT.apiToken = msg.token || '';
      chrome.storage.local.set({ apiToken: BOT.apiToken });
      log(BOT.apiToken ? 'API token saved ✓' : 'API token cleared', 'info');
      sendResponse({ success: true });
    }
    return true;
  });

  // ═══════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ═══════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════

  function init() {
    // Load API token from storage
    chrome.storage.local.get(['apiToken'], (d) => {
      if (d.apiToken) { BOT.apiToken = d.apiToken; log('API token loaded ✓'); }
    });

    const tryCreate = () => {
      const board = document.querySelector('cg-board');
      if (board) {
        createOverlay();
        BOT.color = getBoardOrientation();
        updateOverlay({ type: 'STATUS', status: 'Ready', active: false });
        updateOverlay({ type: 'COLOR', color: BOT.color });
        return true;
      }
      return false;
    };

    if (!tryCreate()) {
      const poller = setInterval(() => { if (tryCreate()) clearInterval(poller); }, 800);
    }

    // Watch for SPA navigation
    new MutationObserver(() => {
      const board = document.querySelector('cg-board');
      const overlay = document.getElementById('sf-bot-overlay');
      if (board && !overlay) {
        createOverlay();
        BOT.color = getBoardOrientation();
        updateOverlay({ type: 'COLOR', color: BOT.color });
      }
    }).observe(document.body, { childList: true, subtree: false });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

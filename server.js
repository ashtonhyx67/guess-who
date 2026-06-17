const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── Static file server ──
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(d);
      });
    } else {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' }); res.end(data);
    }
  });
});

const wss = new WebSocket.Server({ server });

// ══════════════════════════════════════
//  GAME STATE
// ══════════════════════════════════════
let photos = [];           // [{ id, src }]
let clients = {};          // clientId -> { ws, name, status:'lobby'|'waiting'|'playing', gameId }
let games = {};            // gameId -> { p1, p2, phase:'loading'|'pick'|'playing'|'gameover', turn, result }
let nextId = 1;
let nextGameId = 1;
const ADMIN_PASSWORD = 'admin123';

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function send(clientId, msg) {
  const c = clients[clientId];
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

function broadcastLobby() {
  const waiting = Object.entries(clients)
    .filter(([, c]) => c.status === 'waiting')
    .map(([id, c]) => ({ id, name: c.name }));
  const online = Object.entries(clients)
    .map(([id, c]) => ({ id, name: c.name, status: c.status }));
  Object.keys(clients).forEach(id => {
    send(id, { type: 'lobby_update', waiting, online, photos: photos.map(p => ({ id: p.id, src: p.src })) });
  });
}

function sendGameState(gameId) {
  const g = games[gameId];
  if (!g) return;
  [g.p1, g.p2].forEach(pid => {
    const me = g.players[pid];
    const oppId = pid === g.p1 ? g.p2 : g.p1;
    const opp = g.players[oppId];
    send(pid, {
      type: 'game_state',
      phase: g.phase,
      photos,
      me: { id: pid, name: clients[pid]?.name, secret: me.secret, eliminated: [...me.eliminated] },
      opponent: { id: oppId, name: clients[oppId]?.name, secretPicked: opp.secret !== null, eliminated: [...opp.eliminated], secret: g.phase === 'gameover' ? opp.secret : null },
      turn: g.turn,
      result: g.result || null,
    });
  });
}

function startGame(p1id, p2id) {
  const gameId = String(nextGameId++);
  games[gameId] = {
    p1: p1id, p2: p2id,
    phase: 'loading',
    turn: null,
    result: null,
    players: {
      [p1id]: { secret: null, eliminated: new Set() },
      [p2id]: { secret: null, eliminated: new Set() },
    }
  };
  clients[p1id].status = 'playing';
  clients[p1id].gameId = gameId;
  clients[p2id].status = 'playing';
  clients[p2id].gameId = gameId;

  // Notify both of match + loading phase
  [p1id, p2id].forEach(pid => {
    send(pid, {
      type: 'matched',
      gameId,
      opponentName: clients[pid === p1id ? p2id : p1id]?.name,
    });
  });

  broadcastLobby();

  // After 4 seconds move to pick phase
  setTimeout(() => {
    if (!games[gameId]) return;
    games[gameId].phase = 'pick';
    sendGameState(gameId);
  }, 4000);

  return gameId;
}

// ══════════════════════════════════════
//  WEBSOCKET
// ══════════════════════════════════════
wss.on('connection', ws => {
  const clientId = String(nextId++);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    // ── JOIN LOBBY ──
    if (msg.type === 'join') {
      clients[clientId] = { ws, name: (msg.name || 'Player').slice(0, 20), status: 'lobby', gameId: null };
      send(clientId, { type: 'welcome', clientId, photos });
      broadcastLobby();
    }

    // ── READY TO PLAY (join waiting list) ──
    else if (msg.type === 'ready') {
      const c = clients[clientId];
      if (!c || c.status !== 'lobby') return;
      c.status = 'waiting';
      broadcastLobby();
    }

    // ── CANCEL WAITING ──
    else if (msg.type === 'cancel_wait') {
      const c = clients[clientId];
      if (!c) return;
      c.status = 'lobby';
      broadcastLobby();
    }

    // ── CHALLENGE someone ──
    else if (msg.type === 'challenge') {
      const challenger = clients[clientId];
      const target = clients[msg.targetId];
      if (!challenger || !target) return;
      if (challenger.status !== 'waiting' || target.status !== 'waiting') {
        send(clientId, { type: 'error', text: 'That player is no longer available.' }); return;
      }
      if (photos.length < 2) {
        send(clientId, { type: 'error', text: 'Admin needs to upload photos first.' }); return;
      }
      startGame(clientId, msg.targetId);
    }

    // ── PICK SECRET ──
    else if (msg.type === 'pick_secret') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'pick') return;
      const taken = Object.entries(g.players).find(([id, p]) => id !== clientId && p.secret === msg.photoId);
      if (taken) { send(clientId, { type: 'error', text: 'Already picked by opponent!' }); return; }
      g.players[clientId].secret = msg.photoId;
      // Check if both picked
      const both = Object.values(g.players).every(p => p.secret !== null);
      if (both) { g.phase = 'playing'; g.turn = g.p1; }
      sendGameState(c.gameId);
    }

    // ── ELIMINATE ──
    else if (msg.type === 'toggle_eliminate') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'playing') return;
      const elim = g.players[clientId].eliminated;
      // One-way only — can only add, not remove
      elim.add(msg.photoId);
      sendGameState(c.gameId);
    }

    // ── END TURN ──
    else if (msg.type === 'end_turn') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'playing' || g.turn !== clientId) return;
      g.turn = clientId === g.p1 ? g.p2 : g.p1;
      sendGameState(c.gameId);
    }

    // ── GUESS ──
    else if (msg.type === 'guess') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'playing' || g.turn !== clientId) return;
      const oppId = clientId === g.p1 ? g.p2 : g.p1;
      const correct = g.players[oppId].secret === msg.photoId;
      g.phase = 'gameover';
      g.result = {
        correct, guesserId: clientId,
        guesserName: clients[clientId]?.name,
        guessedPhotoId: msg.photoId,
        actualPhotoId: g.players[oppId].secret,
        guessedPhotoSrc: photos.find(p => p.id === msg.photoId)?.src,
        actualPhotoSrc: photos.find(p => p.id === g.players[oppId].secret)?.src,
      };
      sendGameState(c.gameId);
    }

    // ── PLAY AGAIN (return to lobby) ──
    else if (msg.type === 'back_to_lobby') {
      const c = clients[clientId];
      if (!c) return;
      c.status = 'lobby';
      c.gameId = null;
      broadcastLobby();
      send(clientId, { type: 'go_lobby' });
    }

    // ── ADMIN: upload photos ──
    else if (msg.type === 'admin_photos') {
      if (msg.password !== ADMIN_PASSWORD) { send(clientId, { type: 'error', text: 'Wrong password.' }); return; }
      photos = (msg.photos || []).slice(0, 40).map((p, i) => ({ id: i, src: p.src || p, name: p.name || '' }));
      broadcastLobby();
      send(clientId, { type: 'admin_ok', text: `${photos.length} photos uploaded!` });
    }

    // ── ADMIN: hard reset ──
    else if (msg.type === 'admin_reset') {
      if (msg.password !== ADMIN_PASSWORD) { send(clientId, { type: 'error', text: 'Wrong password.' }); return; }
      // Kill all games
      Object.keys(games).forEach(gid => delete games[gid]);
      // Return everyone to lobby
      Object.entries(clients).forEach(([id, c]) => { c.status = 'lobby'; c.gameId = null; send(id, { type: 'go_lobby' }); });
      broadcastLobby();
      send(clientId, { type: 'admin_ok', text: 'Hard reset done — everyone sent to lobby.' });
    }
  });

  ws.on('close', () => {
    const c = clients[clientId];
    if (c && c.gameId) {
      const g = games[c.gameId];
      if (g) {
        const oppId = clientId === g.p1 ? g.p2 : g.p1;
        send(oppId, { type: 'opponent_left' });
        clients[oppId] && (clients[oppId].status = 'lobby') && (clients[oppId].gameId = null);
        delete games[c.gameId];
      }
    }
    delete clients[clientId];
    broadcastLobby();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Guess Who running on port ${PORT}`));
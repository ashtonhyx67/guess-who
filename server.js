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
//  SERVER STATE
// ══════════════════════════════════════
let photos = [];
// clients: id -> { ws, name, status: 'lobby'|'waiting'|'playing', gameId }
let clients = {};
// games: id -> { p1, p2, phase: 'pick'|'playing'|'gameover', turn, result, players: { [id]: { secret, eliminated:Set, guessesLeft } } }
let games = {};
// pending challenges: challengerId -> { targetId, timer }
let pendingChallenges = {};
let nextId = 1;
let nextGameId = 1;
const ADMIN_PASSWORD = 'admin123';
const MAX_GUESSES = 3;

// ══════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════
function send(clientId, msg) {
  const c = clients[clientId];
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// FIX 1: Only send lobby updates to lobby/waiting players — never to players in a game
function broadcastLobby() {
  const waiting = Object.entries(clients)
    .filter(([, c]) => c.status === 'waiting')
    .map(([id, c]) => ({ id, name: c.name }));
  const online = Object.entries(clients)
    .map(([id, c]) => ({ id, name: c.name, status: c.status }));
  const photosMeta = photos.map(p => ({ id: p.id, src: p.src, name: p.name }));

  Object.entries(clients).forEach(([id, c]) => {
    // FIX 1: skip players who are in an active game
    if (c.status === 'playing') return;
    send(id, { type: 'lobby_update', waiting, online, photos: photosMeta });
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
      me: {
        id: pid,
        name: clients[pid]?.name,
        secret: me.secret,
        eliminated: [...me.eliminated],
        guessesLeft: me.guessesLeft,
      },
      opponent: {
        id: oppId,
        name: clients[oppId]?.name,
        secretPicked: opp.secret !== null,
        eliminated: [...opp.eliminated],
        secret: g.phase === 'gameover' ? opp.secret : null,
        guessesLeft: opp.guessesLeft,
      },
      turn: g.turn,
      result: g.result || null,
    });
  });
}

function startGame(p1id, p2id) {
  const gameId = String(nextGameId++);
  games[gameId] = {
    p1: p1id, p2: p2id,
    phase: 'pick',
    turn: null,
    result: null,
    players: {
      [p1id]: { secret: null, eliminated: new Set(), guessesLeft: MAX_GUESSES },
      [p2id]: { secret: null, eliminated: new Set(), guessesLeft: MAX_GUESSES },
    }
  };
  clients[p1id].status = 'playing';
  clients[p1id].gameId = gameId;
  clients[p2id].status = 'playing';
  clients[p2id].gameId = gameId;

  // FIX 3: Send 'matched' for the intermission screen — server waits 3s then sends game_state(pick)
  [p1id, p2id].forEach(pid => {
    send(pid, {
      type: 'matched',
      gameId,
      opponentName: clients[pid === p1id ? p2id : p1id]?.name,
    });
  });

  // Update lobby for non-playing clients
  broadcastLobby();

  // FIX 3: After 3 seconds, move to pick phase
  setTimeout(() => {
    if (!games[gameId]) return;
    sendGameState(gameId);
  }, 3000);

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

    // ── GO WAITING ──
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

    // FIX 2: CHALLENGE — send challenge request to target instead of starting immediately
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
      // Store pending challenge
      pendingChallenges[clientId] = { targetId: msg.targetId };
      // Notify the target they've been challenged
      send(msg.targetId, {
        type: 'challenge_received',
        challengerId: clientId,
        challengerName: challenger.name,
      });
      // Notify challenger that request was sent
      send(clientId, { type: 'challenge_sent', targetName: target.name });
    }

    // FIX 2: ACCEPT CHALLENGE
    else if (msg.type === 'accept_challenge') {
      const target = clients[clientId];
      const challengerId = msg.challengerId;
      const challenge = pendingChallenges[challengerId];
      if (!challenge || challenge.targetId !== clientId) {
        send(clientId, { type: 'error', text: 'Challenge no longer valid.' }); return;
      }
      const challenger = clients[challengerId];
      if (!challenger || challenger.status !== 'waiting' || target.status !== 'waiting') {
        send(clientId, { type: 'error', text: 'Player is no longer available.' }); return;
      }
      delete pendingChallenges[challengerId];
      startGame(challengerId, clientId);
    }

    // FIX 2: DECLINE CHALLENGE
    else if (msg.type === 'decline_challenge') {
      const challengerId = msg.challengerId;
      delete pendingChallenges[challengerId];
      send(challengerId, { type: 'challenge_declined', declinerName: clients[clientId]?.name });
    }

    // FIX 4: PICK SECRET — store choice but wait for confirm
    else if (msg.type === 'pick_secret') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'pick') return;
      const taken = Object.entries(g.players).find(([id, p]) => id !== clientId && p.secret === msg.photoId);
      if (taken) { send(clientId, { type: 'error', text: 'Already picked by opponent!' }); return; }
      // FIX 4: confirmed flag means final lock-in
      if (msg.confirmed) {
        g.players[clientId].secret = msg.photoId;
        const both = Object.values(g.players).every(p => p.secret !== null);
        if (both) { g.phase = 'playing'; g.turn = g.p1; }
        sendGameState(c.gameId);
      } else {
        // Just acknowledge the selection (no state change needed, frontend handles preview)
        send(clientId, { type: 'pick_ack', photoId: msg.photoId });
      }
    }

    // FIX 5: ELIMINATE — only allowed on your own turn
    else if (msg.type === 'toggle_eliminate') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'playing') return;
      // FIX 5: can only eliminate on your own turn
      if (g.turn !== clientId) {
        send(clientId, { type: 'error', text: "It's not your turn!" }); return;
      }
      const elim = g.players[clientId].eliminated;
      elim.add(msg.photoId); // one-way only

      // FIX 6: Auto-guess if only one card left uneliminated
      const remaining = photos.filter(p => !elim.has(p.id));
      if (remaining.length === 1) {
        // auto-guess that last person
        const oppId = clientId === g.p1 ? g.p2 : g.p1;
        const correct = g.players[oppId].secret === remaining[0].id;
        g.phase = 'gameover';
        g.result = {
          correct,
          auto: true,
          guesserId: clientId,
          guesserName: clients[clientId]?.name,
          guessedPhotoId: remaining[0].id,
          actualPhotoId: g.players[oppId].secret,
          guessedPhotoSrc: remaining[0].src,
          actualPhotoSrc: photos.find(p => p.id === g.players[oppId].secret)?.src,
        };
      }
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

    // FIX 7: GUESS — max 3 guesses, only on your turn
    else if (msg.type === 'guess') {
      const c = clients[clientId];
      if (!c) return;
      const g = games[c.gameId];
      if (!g || g.phase !== 'playing' || g.turn !== clientId) return;
      const player = g.players[clientId];
      // FIX 7: check guess limit
      if (player.guessesLeft <= 0) {
        send(clientId, { type: 'error', text: 'You have no guesses left!' }); return;
      }
      player.guessesLeft--;
      const oppId = clientId === g.p1 ? g.p2 : g.p1;
      const correct = g.players[oppId].secret === msg.photoId;
      if (correct || player.guessesLeft === 0) {
        g.phase = 'gameover';
        g.result = {
          correct,
          guesserId: clientId,
          guesserName: clients[clientId]?.name,
          guessedPhotoId: msg.photoId,
          actualPhotoId: g.players[oppId].secret,
          guessedPhotoSrc: photos.find(p => p.id === msg.photoId)?.src,
          actualPhotoSrc: photos.find(p => p.id === g.players[oppId].secret)?.src,
        };
      } else {
        // Wrong guess but guesses remain — swap turn
        g.turn = oppId;
      }
      sendGameState(c.gameId);
    }

    // ── BACK TO LOBBY ──
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
      Object.keys(games).forEach(gid => delete games[gid]);
      Object.keys(pendingChallenges).forEach(k => delete pendingChallenges[k]);
      Object.entries(clients).forEach(([id, c]) => { c.status = 'lobby'; c.gameId = null; send(id, { type: 'go_lobby' }); });
      broadcastLobby();
      send(clientId, { type: 'admin_ok', text: 'Hard reset done.' });
    }
  });

  ws.on('close', () => {
    const c = clients[clientId];
    if (c && c.gameId) {
      const g = games[c.gameId];
      if (g) {
        const oppId = clientId === g.p1 ? g.p2 : g.p1;
        send(oppId, { type: 'opponent_left' });
        if (clients[oppId]) { clients[oppId].status = 'lobby'; clients[oppId].gameId = null; }
        delete games[c.gameId];
      }
    }
    // Clean up any pending challenges from or to this client
    delete pendingChallenges[clientId];
    Object.keys(pendingChallenges).forEach(k => {
      if (pendingChallenges[k].targetId === clientId) delete pendingChallenges[k];
    });
    delete clients[clientId];
    broadcastLobby();
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Guess Who running on port ${PORT}`));
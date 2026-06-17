const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// ── Serve static files ──
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d);
      });
    } else {
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    }
  });
});

// ── WebSocket ──
const wss = new WebSocket.Server({ server });

let state = {
  photos: [],
  players: {},
  turn: null,
  phase: 'lobby',
  adminPassword: 'admin123',
};

let nextId = 1;

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function stateFor(playerId) {
  const me = state.players[playerId];
  const opponents = Object.entries(state.players)
    .filter(([id]) => id !== playerId)
    .map(([id, p]) => ({
      id, name: p.name, secretPicked: p.secret !== null,
      secret: state.phase === 'gameover' ? p.secret : null,
      eliminated: [...(p.eliminated || [])],
    }));
  return {
    type: 'state',
    phase: state.phase,
    photos: state.photos,
    players: Object.entries(state.players).map(([id, p]) => ({ id, name: p.name, secretPicked: p.secret !== null })),
    me: me ? { id: playerId, name: me.name, secret: me.secret, eliminated: [...(me.eliminated || [])] } : null,
    opponents,
    turn: state.turn,
  };
}

function broadcastState() {
  Object.entries(state.players).forEach(([id, p]) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) send(p.ws, stateFor(id));
  });
}

function checkBothPicked() {
  const players = Object.values(state.players);
  if (players.length === 2 && players.every(p => p.secret !== null)) {
    state.phase = 'playing';
    state.turn = Object.keys(state.players)[0];
    broadcastState();
  }
}

wss.on('connection', ws => {
  const clientId = String(nextId++);

  send(ws, { type: 'welcome', clientId, phase: state.phase, photos: state.photos });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      if (Object.keys(state.players).length >= 2) {
        send(ws, { type: 'error', text: 'Game is full.' }); return;
      }
      state.players[clientId] = { ws, name: (msg.name || 'Player').slice(0, 20), secret: null, eliminated: new Set() };
      if (state.photos.length > 0 && Object.keys(state.players).length === 2 && state.phase === 'lobby') {
        state.phase = 'pick';
      }
      broadcastState();
    }

    else if (msg.type === 'admin_photos') {
      if (msg.password !== state.adminPassword) { send(ws, { type: 'error', text: 'Wrong password.' }); return; }
      state.photos = (msg.photos || []).slice(0, 25).map((src, i) => ({ id: i, src }));
      state.phase = 'lobby'; state.turn = null;
      Object.values(state.players).forEach(p => { p.secret = null; p.eliminated = new Set(); });
      if (Object.keys(state.players).length === 2) state.phase = 'pick';
      broadcastState();
    }

    else if (msg.type === 'pick_secret') {
      const player = state.players[clientId];
      if (!player || state.phase !== 'pick') return;
      const taken = Object.entries(state.players).find(([id, p]) => id !== clientId && p.secret === msg.photoId);
      if (taken) { send(ws, { type: 'error', text: 'Already picked!' }); return; }
      player.secret = msg.photoId;
      broadcastState();
      checkBothPicked();
    }

    else if (msg.type === 'toggle_eliminate') {
      const player = state.players[clientId];
      if (!player) return;
      if (player.eliminated.has(msg.photoId)) player.eliminated.delete(msg.photoId);
      else player.eliminated.add(msg.photoId);
      broadcastState();
    }

    else if (msg.type === 'end_turn') {
      if (state.phase !== 'playing' || state.turn !== clientId) return;
      const ids = Object.keys(state.players);
      state.turn = ids.find(id => id !== clientId) || clientId;
      broadcastState();
    }

    else if (msg.type === 'guess') {
      if (state.phase !== 'playing' || state.turn !== clientId) return;
      const opp = Object.entries(state.players).find(([id]) => id !== clientId);
      if (!opp) return;
      const correct = opp[1].secret === msg.photoId;
      state.phase = 'gameover';
      const guessedPhoto = state.photos.find(p => p.id === msg.photoId);
      const actualPhoto = state.photos.find(p => p.id === opp[1].secret);
      const result = { correct, guesserId: clientId, guesserName: state.players[clientId].name, guessedPhotoId: msg.photoId, actualPhotoId: opp[1].secret, guessedPhotoSrc: guessedPhoto?.src, actualPhotoSrc: actualPhoto?.src };
      Object.entries(state.players).forEach(([id, p]) => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) { const s = stateFor(id); s.result = result; send(p.ws, s); }
      });
    }

    else if (msg.type === 'play_again') {
      state.phase = 'pick'; state.turn = null;
      Object.values(state.players).forEach(p => { p.secret = null; p.eliminated = new Set(); });
      broadcastState();
    }
  });

  ws.on('close', () => {
    delete state.players[clientId];
    if (state.phase === 'playing' || state.phase === 'pick') state.phase = 'lobby';
    broadcastState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Guess Who running on port ${PORT}`);
});
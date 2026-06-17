const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════
//  GAME STATE
// ═══════════════════════════════════════
let state = {
  photos: [],           // [{ id, src }]
  players: {},          // { ws_id: { id, name, secret, ready, eliminated:Set } }
  turn: null,           // player id whose turn it is
  phase: 'lobby',       // lobby | pick | playing | gameover
  adminPassword: 'admin123',
};

let clients = new Map(); // ws -> { id }
let nextId = 1;

// ═══════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════
function broadcast(msg, exceptWs = null) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws !== exceptWs) {
      ws.send(data);
    }
  });
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getPlayerList() {
  return Object.entries(state.players).map(([id, p]) => ({
    id,
    name: p.name,
    ready: p.ready,
    secretPicked: p.secret !== null,
  }));
}

function fullStateFor(playerId) {
  const me = state.players[playerId];
  const opponents = Object.entries(state.players)
    .filter(([id]) => id !== playerId)
    .map(([id, p]) => ({
      id,
      name: p.name,
      ready: p.ready,
      secretPicked: p.secret !== null,
      // reveal secret only after game over
      secret: state.phase === 'gameover' ? p.secret : null,
      eliminated: [...(p.eliminated || [])],
    }));

  return {
    type: 'state',
    phase: state.phase,
    photos: state.photos,
    players: getPlayerList(),
    me: me ? {
      id: playerId,
      name: me.name,
      secret: me.secret,
      eliminated: [...(me.eliminated || [])],
    } : null,
    opponents,
    turn: state.turn,
  };
}

function checkBothPicked() {
  const players = Object.values(state.players);
  if (players.length === 2 && players.every(p => p.secret !== null)) {
    state.phase = 'playing';
    // first player to join goes first
    state.turn = Object.keys(state.players)[0];
    broadcastFullState();
  }
}

function broadcastFullState() {
  Object.entries(state.players).forEach(([id, p]) => {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      send(p.ws, fullStateFor(id));
    }
  });
}

// ═══════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════
wss.on('connection', ws => {
  const clientId = String(nextId++);
  clients.set(ws, { id: clientId });

  // Send current photos + phase immediately
  send(ws, {
    type: 'welcome',
    clientId,
    phase: state.phase,
    photos: state.photos,
    players: getPlayerList(),
  });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN as a player ──
      case 'join': {
        const existing = Object.values(state.players);
        if (existing.length >= 2) {
          send(ws, { type: 'error', text: 'Game is full (2 players max).' });
          return;
        }
        // Check if this is a rejoin by name
        const name = (msg.name || 'Player').trim().slice(0, 20);
        state.players[clientId] = {
          ws,
          name,
          secret: null,
          ready: false,
          eliminated: new Set(),
        };
        broadcastFullState();
        // If photos loaded and 2 players, move to pick phase
        if (state.photos.length > 0 && Object.keys(state.players).length === 2 && state.phase === 'lobby') {
          state.phase = 'pick';
          broadcastFullState();
        }
        break;
      }

      // ── ADMIN: upload photos ──
      case 'admin_photos': {
        if (msg.password !== state.adminPassword) {
          send(ws, { type: 'error', text: 'Wrong admin password.' });
          return;
        }
        state.photos = (msg.photos || []).slice(0, 25).map((src, i) => ({ id: i, src }));
        // Reset game state to lobby
        state.phase = 'lobby';
        state.turn = null;
        Object.values(state.players).forEach(p => { p.secret = null; p.ready = false; p.eliminated = new Set(); });
        // If 2 players already joined, jump to pick
        if (Object.keys(state.players).length === 2) {
          state.phase = 'pick';
        }
        broadcastFullState();
        break;
      }

      // ── PICK secret character ──
      case 'pick_secret': {
        const player = state.players[clientId];
        if (!player) return;
        if (state.phase !== 'pick') { send(ws, { type: 'error', text: 'Not in pick phase.' }); return; }
        const photo = state.photos.find(p => p.id === msg.photoId);
        if (!photo) return;
        // Prevent both picking same
        const takenBy = Object.entries(state.players).find(([id, p]) => id !== clientId && p.secret === msg.photoId);
        if (takenBy) { send(ws, { type: 'error', text: 'That person was already picked by your opponent!' }); return; }
        player.secret = msg.photoId;
        broadcastFullState();
        checkBothPicked();
        break;
      }

      // ── FLIP / ELIMINATE a card ──
      case 'toggle_eliminate': {
        const player = state.players[clientId];
        if (!player || state.phase !== 'playing') return;
        const pid = msg.photoId;
        if (player.eliminated.has(pid)) player.eliminated.delete(pid);
        else player.eliminated.add(pid);
        broadcastFullState();
        break;
      }

      // ── END TURN ──
      case 'end_turn': {
        if (state.phase !== 'playing') return;
        if (state.turn !== clientId) { send(ws, { type: 'error', text: "It's not your turn." }); return; }
        // swap turn
        const ids = Object.keys(state.players);
        state.turn = ids.find(id => id !== clientId) || clientId;
        broadcastFullState();
        break;
      }

      // ── MAKE A GUESS ──
      case 'guess': {
        if (state.phase !== 'playing') return;
        if (state.turn !== clientId) { send(ws, { type: 'error', text: "It's not your turn." }); return; }
        const opponent = Object.entries(state.players).find(([id]) => id !== clientId);
        if (!opponent) return;
        const [oppId, oppPlayer] = opponent;
        const correct = oppPlayer.secret === msg.photoId;
        state.phase = 'gameover';

        // Build result
        const guesserName = state.players[clientId].name;
        const guessedPhoto = state.photos.find(p => p.id === msg.photoId);
        const actualPhoto = state.photos.find(p => p.id === oppPlayer.secret);

        const result = {
          correct,
          guesserId: clientId,
          guesserName,
          guessedPhotoId: msg.photoId,
          actualPhotoId: oppPlayer.secret,
          guessedPhotoSrc: guessedPhoto?.src,
          actualPhotoSrc: actualPhoto?.src,
        };

        // Broadcast gameover with result
        Object.entries(state.players).forEach(([id, p]) => {
          if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            const fs = fullStateFor(id);
            fs.result = result;
            send(p.ws, fs);
          }
        });
        break;
      }

      // ── PLAY AGAIN ──
      case 'play_again': {
        state.phase = 'pick';
        state.turn = null;
        Object.values(state.players).forEach(p => { p.secret = null; p.ready = false; p.eliminated = new Set(); });
        broadcastFullState();
        break;
      }
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    if (state.players[clientId]) {
      delete state.players[clientId];
      broadcast({ type: 'player_left', playerId: clientId, players: getPlayerList() });
      // If game was playing, pause it
      if (state.phase === 'playing' || state.phase === 'pick') {
        state.phase = 'lobby';
        state.turn = null;
      }
      broadcastFullState();
    }
  });
});

// ═══════════════════════════════════════
//  START
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎭 Guess Who server running!`);
  console.log(`   Open http://localhost:${PORT} on both laptops`);
  console.log(`   Admin password: ${state.adminPassword}\n`);
});

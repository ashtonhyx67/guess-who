const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'xzone';            // FIX 7
const MAX_GUESSES = 3;
const MAX_PHOTOS = 25;                     // FIX 5
// Use Railway persistent volume at /data if it exists, otherwise local folder
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const PHOTOS_FILE = path.join(DATA_DIR, 'photos.json');

// ─────────────────────────────────────────
//  Load photos from persistent storage on startup
// ─────────────────────────────────────────
let photos = [];
try {
  if (fs.existsSync(PHOTOS_FILE)) {
    photos = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8'));
    console.log(`Loaded ${photos.length} photos from ${PHOTOS_FILE}`);
  }
} catch(e) { console.error('Failed to load photos:', e.message); }

function savePhotos() {
  try {
    fs.writeFileSync(PHOTOS_FILE, JSON.stringify(photos));
    console.log(`Saved ${photos.length} photos to ${PHOTOS_FILE}`);
  }
  catch(e) { console.error('Failed to save photos:', e.message); }
}

// ─────────────────────────────────────────
//  STATIC SERVER
// ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    const ext = path.extname(filePath);
    const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css' };
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

// ─────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────
let clients = {};
// game: { p1, p2, phase:'pick'|'playing'|'snipe'|'gameover', turn, snipe:{}, result, players:{} }
let games = {};
let pendingChallenges = {};  // challengerId -> { targetId }
let nextId = 1;
let nextGameId = 1;

// ─────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────
function send(clientId, msg) {
  const c = clients[clientId];
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// FIX 1 & 3: broadcastLobby only to lobby/waiting players
function broadcastLobby() {
  const waiting = Object.entries(clients)
    .filter(([,c]) => c.status === 'waiting')
    .map(([id,c]) => ({ id, name: c.name }));
  const online = Object.entries(clients)
    .map(([id,c]) => ({ id, name: c.name, status: c.status }));
  const photosMeta = photos.map(p => ({ id: p.id, src: p.src, name: p.name }));
  Object.entries(clients).forEach(([id,c]) => {
    if (c.status === 'playing') return; // FIX 1: never interrupt playing clients
    send(id, { type: "lobby_update", waiting, online, photos: photosMeta, myStatus: c.status });
  });
}

function sendGameState(gameId) {
  const g = games[gameId];
  if (!g) return;
  [g.p1, g.p2].forEach(pid => {
    const me = g.players[pid];
    const oppId = pid === g.p1 ? g.p2 : g.p1;
    const opp = g.players[oppId];
    // FIX 6: include snipe state
    let snipeInfo = null;
    if (g.phase === 'snipe') {
      snipeInfo = {
        initiatorId: g.snipe.initiatorId,
        initiatorName: clients[g.snipe.initiatorId]?.name,
        initiatorGuessId: g.snipe.initiatorGuessId,
        myChoice: g.snipe.choices[pid] ?? null,   // null=pending, photoId=guessed, 'pass'=passed
        oppChoice: g.snipe.choices[oppId] ?? null,
      };
    }
    send(pid, {
      type: 'game_state',
      phase: g.phase,
      photos,
      me: { id: pid, name: clients[pid]?.name, secret: me.secret, eliminated: [...me.eliminated], guessesLeft: me.guessesLeft },
      opponent: { id: oppId, name: clients[oppId]?.name, secretPicked: opp.secret !== null, eliminated: [...opp.eliminated], secret: (g.phase === 'gameover') ? opp.secret : null },
      turn: g.turn,
      result: g.result || null,
      snipe: snipeInfo,
    });
  });
}

function startGame(p1id, p2id) {
  const gameId = String(nextGameId++);
  games[gameId] = {
    p1: p1id, p2: p2id,
    phase: 'pick',
    turn: null, result: null,
    snipe: null,
    players: {
      [p1id]: { secret: null, eliminated: new Set(), guessesLeft: MAX_GUESSES },
      [p2id]: { secret: null, eliminated: new Set(), guessesLeft: MAX_GUESSES },
    }
  };
  clients[p1id].status = 'playing'; clients[p1id].gameId = gameId;
  clients[p2id].status = 'playing'; clients[p2id].gameId = gameId;

  [p1id, p2id].forEach(pid => {
    send(pid, { type: 'matched', gameId, opponentName: clients[pid === p1id ? p2id : p1id]?.name });
  });
  broadcastLobby();

  // FIX 3: 3 second intermission then send game state
  setTimeout(() => { if (games[gameId]) sendGameState(gameId); }, 3000);
  return gameId;
}

function resolveSnipe(gameId) {
  const g = games[gameId];
  if (!g || g.phase !== 'snipe') return;
  const { initiatorId, initiatorGuessId, choices } = g.snipe;
  const responderId = initiatorId === g.p1 ? g.p2 : g.p1;
  const responderChoice = choices[responderId]; // photoId or 'pass'
  const initiatorCorrect = g.players[responderId].secret === initiatorGuessId;
  const responderGuessed = responderChoice && responderChoice !== 'pass';
  const responderCorrect = responderGuessed && g.players[initiatorId].secret === responderChoice;

  if (!initiatorCorrect && !responderCorrect) {
    // Both wrong — eliminate initiator's guessed card and resume
    g.players[initiatorId].eliminated.add(initiatorGuessId);
    if (responderGuessed) g.players[responderId].eliminated.add(responderChoice);
    g.snipe = null;
    g.phase = 'playing';
    // Turn passes to responder (since initiator "wasted" a guess)
    g.turn = responderId;
    sendGameState(gameId);
    return;
  }

  // At least one correct
  g.phase = 'gameover';
  let resultMsg = '';
  if (initiatorCorrect && responderCorrect) {
    resultMsg = 'tie';
  } else if (initiatorCorrect) {
    resultMsg = 'initiator';
  } else {
    resultMsg = 'responder';
  }

  g.result = {
    snipeResult: resultMsg,
    initiatorId, responderId,
    initiatorName: clients[initiatorId]?.name,
    responderName: clients[responderId]?.name,
    initiatorGuessId,
    responderGuessId: responderGuessed ? responderChoice : null,
    initiatorCorrect, responderCorrect,
    p1SecretSrc: photos.find(p => p.id === g.players[g.p1].secret)?.src,
    p2SecretSrc: photos.find(p => p.id === g.players[g.p2].secret)?.src,
    guessedPhotoSrc: photos.find(p => p.id === initiatorGuessId)?.src,
    actualPhotoSrc: photos.find(p => p.id === g.players[responderId].secret)?.src,
    correct: initiatorCorrect, // for legacy compat
    guesserId: initiatorId,
    guesserName: clients[initiatorId]?.name,
    guessedPhotoId: initiatorGuessId,
    actualPhotoId: g.players[responderId].secret,
    guessedPhotoSrc: photos.find(p => p.id === initiatorGuessId)?.src,
    actualPhotoSrc: photos.find(p => p.id === g.players[responderId].secret)?.src,
  };
  sendGameState(gameId);
}

// ─────────────────────────────────────────
//  WEBSOCKET
// ─────────────────────────────────────────
wss.on('connection', ws => {
  const clientId = String(nextId++);

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      clients[clientId] = { ws, name: (msg.name||'Player').slice(0,20), status:'lobby', gameId:null };
      send(clientId, { type:'welcome', clientId, photos });
      // Send full lobby state to the new client right away
      const waiting = Object.entries(clients).filter(([,c])=>c.status==='waiting').map(([id,c])=>({id,name:c.name}));
      const online = Object.entries(clients).map(([id,c])=>({id,name:c.name,status:c.status}));
      send(clientId, { type:'lobby_update', waiting, online, photos, myStatus:'lobby' });
      broadcastLobby();
    }

    else if (msg.type === 'ready') {
      const c = clients[clientId];
      if (!c || c.status !== 'lobby') return;
      c.status = 'waiting';
      broadcastLobby();
    }

    else if (msg.type === 'cancel_wait') {
      const c = clients[clientId];
      if (!c) return;
      c.status = 'lobby';
      // FIX 2: clean up any pending challenges from this player
      delete pendingChallenges[clientId];
      broadcastLobby();
    }

    // FIX 2: more robust challenge flow
    else if (msg.type === 'challenge') {
      const challenger = clients[clientId];
      const target = clients[msg.targetId];
      if (!challenger || !target) { send(clientId, { type:'error', text:'Player not found.' }); return; }
      if (challenger.status !== 'waiting') { send(clientId, { type:'error', text:'You must be searching to challenge.' }); return; }
      if (target.status !== 'waiting') { send(clientId, { type:'error', text:'That player is no longer searching.' }); return; }
      if (photos.length < 2) { send(clientId, { type:'error', text:'Admin needs to upload photos first.' }); return; }
      // FIX 2: overwrite any previous pending challenge
      pendingChallenges[clientId] = { targetId: msg.targetId, timestamp: Date.now() };
      send(msg.targetId, { type:'challenge_received', challengerId: clientId, challengerName: challenger.name });
      send(clientId, { type:'challenge_sent', targetName: target.name });
    }

    else if (msg.type === 'accept_challenge') {
      const target = clients[clientId];
      const challengerId = msg.challengerId;
      const challenge = pendingChallenges[challengerId];
      if (!challenge || challenge.targetId !== clientId) { send(clientId, { type:'error', text:'Challenge expired.' }); return; }
      const challenger = clients[challengerId];
      if (!challenger || challenger.status !== 'waiting' || !target || target.status !== 'waiting') {
        send(clientId, { type:'error', text:'Player no longer available.' }); return;
      }
      delete pendingChallenges[challengerId];
      startGame(challengerId, clientId);
    }

    else if (msg.type === 'decline_challenge') {
      delete pendingChallenges[msg.challengerId];
      send(msg.challengerId, { type:'challenge_declined', declinerName: clients[clientId]?.name });
    }

    // FIX 4: pick secret — check uniqueness server side
    else if (msg.type === 'pick_secret') {
      const c = clients[clientId]; if (!c) return;
      const g = games[c.gameId]; if (!g || g.phase !== 'pick') return;
      if (!msg.confirmed) return; // must be confirmed
      // FIX 4: reject if opponent already picked this
      const oppId = clientId === g.p1 ? g.p2 : g.p1;
      if (g.players[oppId].secret === msg.photoId) {
        send(clientId, { type:'error', text:'Your opponent already chose that person! Pick someone else.' }); return;
      }
      g.players[clientId].secret = msg.photoId;
      const both = Object.values(g.players).every(p => p.secret !== null);
      if (both) { g.phase = 'playing'; g.turn = g.p1; }
      sendGameState(c.gameId);
    }

    else if (msg.type === 'toggle_eliminate') {
      const c = clients[clientId]; if (!c) return;
      const g = games[c.gameId]; if (!g || g.phase !== 'playing') return;
      if (g.turn !== clientId) return; // FIX 5: only on your turn
      g.players[clientId].eliminated.add(msg.photoId);
      // FIX 5: auto-snipe if only 1 card remaining
      const remaining = photos.filter(p => !g.players[clientId].eliminated.has(p.id));
      if (remaining.length === 1) {
        // auto guess — start snipe round with that card
        const oppId = clientId === g.p1 ? g.p2 : g.p1;
        g.phase = 'snipe';
        g.snipe = { initiatorId: clientId, initiatorGuessId: remaining[0].id, choices: { [clientId]: remaining[0].id } };
        // immediately resolve (responder gets chance via snipe_respond)
        sendGameState(c.gameId);
      } else {
        sendGameState(c.gameId);
      }
    }

    else if (msg.type === 'end_turn') {
      const c = clients[clientId]; if (!c) return;
      const g = games[c.gameId]; if (!g || g.phase !== 'playing' || g.turn !== clientId) return;
      g.turn = clientId === g.p1 ? g.p2 : g.p1;
      sendGameState(c.gameId);
    }

    // FIX 6: guess — initiates a snipe round
    else if (msg.type === 'guess') {
      const c = clients[clientId]; if (!c) return;
      const g = games[c.gameId]; if (!g || g.phase !== 'playing' || g.turn !== clientId) return;
      const player = g.players[clientId];
      if (player.guessesLeft <= 0) { send(clientId, { type:'error', text:'No guesses left!' }); return; }
      player.guessesLeft--;
      // Start snipe phase — opponent gets to respond
      g.phase = 'snipe';
      g.snipe = { initiatorId: clientId, initiatorGuessId: msg.photoId, choices: { [clientId]: msg.photoId } };
      sendGameState(c.gameId);
    }

    // FIX 6: snipe response (opponent decides to counter-guess or pass)
    else if (msg.type === 'snipe_respond') {
      const c = clients[clientId]; if (!c) return;
      const g = games[c.gameId]; if (!g || g.phase !== 'snipe') return;
      if (g.snipe.initiatorId === clientId) return; // only responder
      // msg.photoId = their guess, or null = pass
      g.snipe.choices[clientId] = msg.photoId || 'pass';
      resolveSnipe(c.gameId);
    }

    else if (msg.type === 'back_to_lobby') {
      const c = clients[clientId]; if (!c) return;
      c.status = 'lobby'; c.gameId = null;
      broadcastLobby();
      send(clientId, { type:'go_lobby' });
    }

    else if (msg.type === 'admin_photos') {
      if (msg.password !== ADMIN_PASSWORD) { send(clientId, { type:'error', text:'Wrong password.' }); return; }
      // FIX 1 & 5: save to disk, cap at 25
      photos = (msg.photos||[]).slice(0, MAX_PHOTOS).map((p,i) => ({ id:i, src:p.src||p, name:p.name||'' }));
      savePhotos(); // FIX 1: persist to disk
      broadcastLobby();
      send(clientId, { type:'admin_ok', text:`${photos.length} photos saved!` });
    }

    // FIX 1: delete a single photo
    else if (msg.type === 'admin_delete_photo') {
      if (msg.password !== ADMIN_PASSWORD) { send(clientId, { type:'error', text:'Wrong password.' }); return; }
      photos = photos.filter(p => p.id !== msg.photoId).map((p,i) => ({ ...p, id:i }));
      savePhotos();
      broadcastLobby();
      send(clientId, { type:'admin_ok', text:'Photo removed.' });
    }

    // FIX 3: hard reset — properly send everyone to lobby
    else if (msg.type === 'admin_reset') {
      if (msg.password !== ADMIN_PASSWORD) { send(clientId, { type:'error', text:'Wrong password.' }); return; }
      Object.keys(games).forEach(gid => delete games[gid]);
      Object.keys(pendingChallenges).forEach(k => delete pendingChallenges[k]);
      // FIX 3: send go_lobby to everyone and reset their status
      Object.entries(clients).forEach(([id, c]) => {
        c.status = 'lobby';
        c.gameId = null;
        send(id, { type: 'force_lobby' }); // use distinct type so client handles it
      });
      setTimeout(broadcastLobby, 100); // small delay so clients process force_lobby first
      send(clientId, { type:'admin_ok', text:'Hard reset done — everyone sent to lobby.' });
    }
  });

  ws.on('close', () => {
    const c = clients[clientId];
    if (c && c.gameId) {
      const g = games[c.gameId];
      if (g) {
        const oppId = clientId === g.p1 ? g.p2 : g.p1;
        send(oppId, { type:'opponent_left' });
        if (clients[oppId]) { clients[oppId].status = 'lobby'; clients[oppId].gameId = null; }
        delete games[c.gameId];
      }
    }
    delete pendingChallenges[clientId];
    Object.keys(pendingChallenges).forEach(k => {
      if (pendingChallenges[k]?.targetId === clientId) delete pendingChallenges[k];
    });
    delete clients[clientId];
    broadcastLobby();
  });
});


// Heartbeat: ping all clients every 15s, remove dead ones
setInterval(() => {
  Object.entries(clients).forEach(([id, c]) => {
    if (c.ws.readyState !== WebSocket.OPEN) {
      delete clients[id];
      broadcastLobby();
    }
  });
}, 15000);

server.listen(PORT, '0.0.0.0', () => console.log(`Guess Who running on port ${PORT}`));
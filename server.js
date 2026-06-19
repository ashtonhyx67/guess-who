const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'xzone';
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const PHOTOS_FILE  = path.join(DATA_DIR, 'photos.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const ACTIVE_FILE  = path.join(DATA_DIR, 'active.json'); // persists active preset choice

// DIAGNOSTIC: confirm whether the Railway persistent volume is actually mounted.
// If this prints "/data NOT FOUND — using ephemeral storage", photos WILL be
// wiped on every redeploy because Railway's container filesystem resets.
// Fix: in Railway dashboard -> your service -> Volumes tab -> add a volume
// mounted at /data.
console.log('========================================');
console.log('DATA_DIR:', DATA_DIR);
console.log(fs.existsSync('/data')
  ? '✅ /data volume IS mounted — photos will persist across restarts'
  : '⚠️  /data volume NOT FOUND — using ' + __dirname + ' which is WIPED on every redeploy!');
console.log('========================================');

let allPhotos = [];  // master library
let photos = [];     // active game set
let presets = [];
let clients = {};
let games = {};
let pendingChallenges = {};
let nextId = 1;
let nextGameId = 1;
// Maps a persistent session token (generated client-side, survives page
// reload / phone sleep) to the player's last-known clientId. Lets us
// recognize "this is the same person reconnecting" instead of treating
// every new WebSocket connection as a brand new player.
let sessions = {}; // sessionId -> clientId

try {
  if (fs.existsSync(PHOTOS_FILE)) {
    const raw = fs.readFileSync(PHOTOS_FILE, 'utf8');
    if (raw && raw.trim()) {
      allPhotos = JSON.parse(raw);
      photos = allPhotos; // active set = full library by default
      console.log('Loaded', allPhotos.length, 'photos from disk');
    }
  } else {
    console.log('No photos file yet — will create on first upload');
  }
} catch(e) {
  console.error('Failed to load photos:', e.message);
  // Try backup
  try {
    if (fs.existsSync(PHOTOS_FILE + '.bak')) {
      allPhotos = JSON.parse(fs.readFileSync(PHOTOS_FILE + '.bak', 'utf8'));
      photos = allPhotos;
      console.log('Loaded', allPhotos.length, 'photos from backup');
    }
  } catch(e2) { console.error('Backup also failed:', e2.message); }
}

try {
  if (fs.existsSync(PRESETS_FILE)) {
    presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
  }
} catch(e) { console.error(e.message); }

// Restore last active preset (including randomizer toggle/count)
try {
  if (fs.existsSync(ACTIVE_FILE) && allPhotos.length > 0) {
    const active = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8'));
    let basePool;
    if (active.presetId === 'all' || active.presetId === 'random') {
      // 'random' is a legacy value from before the randomizer became a
      // toggle — treat it the same as 'all' going forward.
      basePool = allPhotos;
    } else {
      const pr = presets.find(p => p.id === active.presetId);
      basePool = pr ? pr.photoIds.map(pid => allPhotos.find(p => p.id === pid)).filter(Boolean) : allPhotos;
    }
    // NOTE: randomization itself is NOT deterministic across restarts (the
    // exact shuffled subset can't be reproduced), so on restore we just use
    // the full base pool. The randomizer toggle/count is preserved purely
    // as a UI preference for next time the admin hits "Use".
    photos = basePool.map((p,i) => ({...p, id:i}));
    console.log('Restored active set: ' + photos.length + ' photos' + (active.randomize ? ' (randomizer was on, count=' + active.count + ' — re-roll to apply)' : ''));
  }
} catch(e) { console.error('Failed to restore active preset:', e.message); }

function savePhotos() {
  try {
    const data = JSON.stringify(allPhotos);
    fs.writeFileSync(PHOTOS_FILE, data);
    // Also write backup
    fs.writeFileSync(PHOTOS_FILE + '.bak', data);
    console.log('Saved', allPhotos.length, 'photos to disk');
  } catch(e) { console.error('Failed to save photos:', e.message); }
}
function saveActive(presetId, count, randomize, randomCount) {
  try { fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ presetId, count, randomize: !!randomize, randomCount: randomCount||null })); } catch(e) { console.error(e.message); }
}
function savePresets() { try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets));   } catch(e) { console.error(e.message); } }
function shuffle(arr)  { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

const server = http.createServer((req, res) => {
  let fp = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(fp, (err, data) => {
    const ext = path.extname(fp);
    const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css'};
    if (err) { fs.readFile(path.join(__dirname,'public','index.html'),(_,d)=>{ res.writeHead(200,{'Content-Type':'text/html'}); res.end(d); }); }
    else { res.writeHead(200,{'Content-Type':mime[ext]||'text/plain'}); res.end(data); }
  });
});

const wss = new WebSocket.Server({ server, maxPayload: 500 * 1024 * 1024 }); // 500MB max

function send(id, msg) {
  const c = clients[id];
  if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg));
}

// Send photos to a single client — full data with src
function sendPhotos(clientId) {
  send(clientId, { type: 'photos_data', photos });
}

// Broadcast lobby — NO photo src data, just metadata
function broadcastLobby() {
  const waiting = Object.entries(clients).filter(([,c])=>c.status==='waiting').map(([id,c])=>({id,name:c.name}));
  const online  = Object.entries(clients).map(([id,c])=>({id,name:c.name,status:c.status}));
  const meta    = photos.map(p=>({id:p.id,name:p.name})); // NO src
  Object.entries(clients).forEach(([id,c]) => {
    if (c.status === 'playing') return;
    send(id, { type:'lobby_update', waiting, online, photosMeta:meta, myStatus:c.status });
  });
}

// Game state — NO photo src, just IDs. Client uses cached photos.
function sendGameState(gameId) {
  const g = games[gameId];
  if (!g) return;
  const gamePhotos = g.photos || photos; // use game's snapshot, fallback to global
  const photoIds = gamePhotos.map(p=>p.id);
  [g.p1, g.p2].forEach(pid => {
    const me  = g.players[pid];
    const opp = g.players[pid===g.p1?g.p2:g.p1];
    const oppId = pid===g.p1?g.p2:g.p1;
    let snipe = null;
    if (g.phase==='snipe') {
      const amI = pid===g.snipe.initiatorId;
      snipe = { initiatorId:g.snipe.initiatorId, initiatorName:clients[g.snipe.initiatorId]?.name,
                initiatorGuessId: amI?g.snipe.initiatorGuessId:null,
                myChoice:g.snipe.choices[pid]??null, oppChoice:g.snipe.choices[oppId]??null };
    }
    send(pid, {
      type:'game_state', phase:g.phase, photoIds,
      me:  { id:pid, secret:me.secret, eliminated:[...me.eliminated], guessesLeft:me.guessesLeft },
      opponent: { id:oppId, name:clients[oppId]?.name, secretPicked:opp.secret!==null,
                  eliminated:[...opp.eliminated], secret:g.phase==='gameover'?opp.secret:null },
      turn:g.turn, result:g.result||null, snipe
    });
  });
}

function startGame(p1, p2) {
  const gid = String(nextGameId++);
  // Snapshot the active photos at game start — immune to admin changes mid-game
  const gamePhotos = [...photos];
  games[gid] = {
    p1, p2, phase:'pick', turn:null, result:null, snipe:null,
    photos: gamePhotos, // locked-in photos for this game
    players:{ [p1]:{secret:null,eliminated:new Set(),guessesLeft:3}, [p2]:{secret:null,eliminated:new Set(),guessesLeft:3} }
  };
  clients[p1].status='playing'; clients[p1].gameId=gid;
  clients[p2].status='playing'; clients[p2].gameId=gid;
  [p1,p2].forEach(pid => send(pid, {type:'matched',gameId:gid,opponentName:clients[pid===p1?p2:p1]?.name}));
  broadcastLobby();
  // Send game's snapshot photos to both players
  const sendGamePhotos = (pid) => send(pid, { type:'photos_data', photos: gamePhotos });
  [p1,p2].forEach(pid => sendGamePhotos(pid));
  setTimeout(() => {
    if(!games[gid]) return;
    [p1,p2].forEach(pid => sendGamePhotos(pid)); // resend before game_state
    setTimeout(() => { if(games[gid]) sendGameState(gid); }, 200);
  }, 2800);
}

function resolveSnipe(gid) {
  const g = games[gid]; if(!g||g.phase!=='snipe') return;
  const {initiatorId,initiatorGuessId,choices} = g.snipe;
  const responderId = initiatorId===g.p1?g.p2:g.p1;
  const iCorrect = g.players[responderId].secret===initiatorGuessId;
  const rChoice  = choices[responderId];
  const rGuessed = rChoice&&rChoice!=='pass';
  const rCorrect = rGuessed&&g.players[initiatorId].secret===rChoice;
  if (!iCorrect&&!rCorrect) {
    g.players[initiatorId].eliminated.add(initiatorGuessId);
    if(rGuessed) g.players[responderId].eliminated.add(rChoice);
    g.snipe=null; g.phase='playing'; g.turn=responderId;
    sendGameState(gid); return;
  }
  const sr = iCorrect&&rCorrect?'tie':iCorrect?'initiator':'responder';
  g.phase='gameover';
  g.result = {
    snipeResult:sr, initiatorId, responderId,
    initiatorName:clients[initiatorId]?.name, responderName:clients[responderId]?.name,
    initiatorGuessId, responderGuessId:rGuessed?rChoice:null,
    initiatorCorrect:iCorrect, responderCorrect:rCorrect,
    correct:iCorrect, guesserId:initiatorId, guesserName:clients[initiatorId]?.name,
    guessedPhotoId:initiatorGuessId, actualPhotoId:g.players[responderId].secret,
  };
  sendGameState(gid);
}

// How long to wait before treating a disconnected mid-game player as
// actually gone (vs. their phone just locking/backgrounding briefly).
// During this window the game object is kept alive so a session-resumed
// reconnect can slot right back in.
const RECONNECT_GRACE_MS = 45000; // 45 seconds

function handleDisconnect(clientId) {
  const c = clients[clientId]; if(!c) return;
  delete pendingChallenges[clientId];
  Object.keys(pendingChallenges).forEach(k=>{ if(pendingChallenges[k]?.targetId===clientId) delete pendingChallenges[k]; });

  if (c.gameId && games[c.gameId]) {
    const gameId = c.gameId;
    // Don't delete the client record or the game yet — keep both alive so
    // a session-resumed reconnect (phone waking back up) can swap straight
    // back into this exact slot. Only notify the opponent and tear
    // everything down if they're still gone after the grace period.
    setTimeout(() => {
      const g = games[gameId];
      if (!g) return; // already cleaned up (e.g. both left normally via back_to_lobby)
      const current = clients[clientId];
      const stillGone = !current || current.ws.readyState !== WebSocket.OPEN;
      if (!stillGone) return; // they reconnected in time — nothing to do
      const oppId = clientId===g.p1?g.p2:g.p1;
      if (clients[oppId]) { clients[oppId].status='lobby'; clients[oppId].gameId=null; send(oppId,{type:'opponent_left'}); }
      delete games[gameId];
      delete clients[clientId];
      console.log(`Game ${gameId} cleaned up — player ${clientId} did not reconnect within grace period`);
      broadcastLobby();
    }, RECONNECT_GRACE_MS);
    // Still remove them from the visible lobby list immediately (they're
    // not "online" while disconnected) without destroying their game state.
    broadcastLobby();
    return;
  }

  // Not in a game — safe to remove immediately, nothing to preserve.
  delete clients[clientId];
  broadcastLobby();
}

wss.on('connection', ws => {
  const clientId = String(nextId++);
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive=true; });

  ws.on('message', raw => {
    ws.isAlive = true;
    let msg; try { msg=JSON.parse(raw); } catch { return; }

    if (msg.type==='join') {
      const sid = msg.sessionId;
      const prevClientId = sid ? sessions[sid] : null;
      const prevClient = prevClientId ? clients[prevClientId] : null;

      if (prevClient && prevClient.gameId && games[prevClient.gameId]) {
        // RECONNECTION: same session was mid-game. Swap this new WebSocket
        // into the existing client record (keep gameId/status/name intact)
        // and re-point the game's p1/p2 + players map to the new clientId.
        const g = games[prevClient.gameId];
        const oldId = prevClientId;
        // Move client record under the new connection's id
        clients[clientId] = { ...prevClient, ws, name: (msg.name||prevClient.name||'Player').slice(0,20) };
        delete clients[oldId];
        // Re-point game references from oldId -> clientId
        if (g.p1 === oldId) g.p1 = clientId;
        if (g.p2 === oldId) g.p2 = clientId;
        if (g.players[oldId]) { g.players[clientId] = g.players[oldId]; delete g.players[oldId]; }
        if (g.turn === oldId) g.turn = clientId;
        if (g.snipe) {
          if (g.snipe.initiatorId === oldId) g.snipe.initiatorId = clientId;
          if (g.snipe.choices && g.snipe.choices[oldId] !== undefined) { g.snipe.choices[clientId] = g.snipe.choices[oldId]; delete g.snipe.choices[oldId]; }
        }
        if (g.result) {
          if (g.result.guesserId === oldId) g.result.guesserId = clientId;
          if (g.result.initiatorId === oldId) g.result.initiatorId = clientId;
          if (g.result.responderId === oldId) g.result.responderId = clientId;
        }
        sessions[sid] = clientId;
        console.log(`Session ${sid} reconnected: ${oldId} -> ${clientId} (resumed game ${prevClient.gameId})`);
        send(clientId, {type:'welcome', clientId});
        sendPhotos(clientId);
        sendGameState(prevClient.gameId);
        return;
      }

      if (prevClient) {
        // Same session, but they were only in the lobby (not a game) — just
        // carry their old status/name forward onto the new connection.
        clients[clientId] = { ...prevClient, ws, name: (msg.name||prevClient.name||'Player').slice(0,20) };
        if (prevClientId !== clientId) delete clients[prevClientId];
      } else {
        clients[clientId] = {ws, name:(msg.name||'Player').slice(0,20), status:'lobby', gameId:null};
      }
      if (sid) sessions[sid] = clientId;

      send(clientId, {type:'welcome', clientId});
      sendPhotos(clientId);
      const w=Object.entries(clients).filter(([,c])=>c.status==='waiting').map(([id,c])=>({id,name:c.name}));
      const o=Object.entries(clients).map(([id,c])=>({id,name:c.name,status:c.status}));
      send(clientId, {type:'lobby_update',waiting:w,online:o,photosMeta:photos.map(p=>({id:p.id,name:p.name})),myStatus:clients[clientId].status});
      broadcastLobby();
    }
    else if (msg.type==='ready') {
      const c=clients[clientId]; if(!c||c.status!=='lobby') return;
      c.status='waiting'; broadcastLobby();
    }
    else if (msg.type==='cancel_wait') {
      const c=clients[clientId]; if(!c) return;
      c.status='lobby'; delete pendingChallenges[clientId]; broadcastLobby();
    }
    else if (msg.type==='challenge') {
      const cr=clients[clientId],tg=clients[msg.targetId];
      if(!cr||!tg) { send(clientId,{type:'error',text:'Player not found.'}); return; }
      if(cr.status!=='waiting') { send(clientId,{type:'error',text:'You must be searching.'}); return; }
      if(tg.status!=='waiting') { send(clientId,{type:'error',text:'Player no longer searching.'}); return; }
      // Use allPhotos as fallback if active set is empty
      if(photos.length === 0 && allPhotos.length > 0) {
        photos = allPhotos;
        console.log('Fallback: using allPhotos for game');
      }
      if(photos.length<2) { send(clientId,{type:'error',text:`No photos loaded yet — admin must upload photos first (current: ${allPhotos.length} in library, ${photos.length} active).`}); return; }
      pendingChallenges[clientId]={targetId:msg.targetId,timestamp:Date.now()};
      send(msg.targetId,{type:'challenge_received',challengerId:clientId,challengerName:cr.name});
      send(clientId,{type:'challenge_sent',targetName:tg.name});
    }
    else if (msg.type==='accept_challenge') {
      const tg=clients[clientId],ch=pendingChallenges[msg.challengerId];
      if(!ch||ch.targetId!==clientId) { send(clientId,{type:'error',text:'Challenge expired.'}); return; }
      const cr=clients[msg.challengerId];
      if(!cr||cr.status!=='waiting'||!tg||tg.status!=='waiting') { send(clientId,{type:'error',text:'Player no longer available.'}); return; }
      delete pendingChallenges[msg.challengerId];
      // Final photo check before starting
      if(photos.length===0 && allPhotos.length>0) photos=allPhotos;
      startGame(msg.challengerId,clientId);
    }
    else if (msg.type==='decline_challenge') {
      delete pendingChallenges[msg.challengerId];
      send(msg.challengerId,{type:'challenge_declined',declinerName:clients[clientId]?.name});
    }
    else if (msg.type==='pick_secret') {
      const c=clients[clientId]; if(!c) return;
      const g=games[c.gameId]; if(!g||g.phase!=='pick'||!msg.confirmed) return;
      g.players[clientId].secret=msg.photoId;
      if(Object.values(g.players).every(p=>p.secret!==null)) { g.phase='playing'; g.turn=g.p1; }
      sendGameState(c.gameId);
    }
    else if (msg.type==='toggle_eliminate') {
      const c=clients[clientId]; if(!c) return;
      const g=games[c.gameId]; if(!g||g.phase!=='playing') return;
      const elim=g.players[clientId].eliminated;
      const alreadyElim=elim.has(msg.photoId);
      // Flipping a card DOWN (eliminating) only allowed on your own turn.
      // Flipping a card BACK UP (un-eliminating) allowed anytime.
      if(!alreadyElim && g.turn!==clientId) return;
      if(alreadyElim) elim.delete(msg.photoId);
      else elim.add(msg.photoId);
      const gamePhotos=games[c.gameId]?.photos||photos;
      const remaining=gamePhotos.filter(p=>!elim.has(p.id));
      if(remaining.length===1) {
        const oppId=clientId===g.p1?g.p2:g.p1;
        g.phase='snipe'; g.snipe={initiatorId:clientId,initiatorGuessId:remaining[0].id,choices:{[clientId]:remaining[0].id}};
      }
      sendGameState(c.gameId);
    }
    else if (msg.type==='end_turn') {
      const c=clients[clientId]; if(!c) return;
      const g=games[c.gameId]; if(!g||g.phase!=='playing'||g.turn!==clientId) return;
      const next=clientId===g.p1?g.p2:g.p1;
      g.turn=next;
      sendGameState(c.gameId);
    }
    else if (msg.type==='guess') {
      const c=clients[clientId]; if(!c) return;
      const g=games[c.gameId]; if(!g||g.phase!=='playing'||g.turn!==clientId) return;
      const pl=g.players[clientId];
      if(pl.guessesLeft<=0) { send(clientId,{type:'error',text:'No guesses left!'}); return; }
      pl.guessesLeft--;
      g.phase='snipe'; g.snipe={initiatorId:clientId,initiatorGuessId:msg.photoId,choices:{[clientId]:msg.photoId}};
      sendGameState(c.gameId);
    }
    else if (msg.type==='snipe_respond') {
      const c=clients[clientId]; if(!c) return;
      const g=games[c.gameId]; if(!g||g.phase!=='snipe'||g.snipe.initiatorId===clientId) return;
      g.snipe.choices[clientId]=msg.photoId||'pass';
      resolveSnipe(c.gameId);
    }
    else if (msg.type==='back_to_lobby') {
      const c=clients[clientId]; if(!c) return;
      const oldGameId=c.gameId;
      c.status='lobby'; c.gameId=null;
      // Clean up the game object once a player leaves it (game is over by now,
      // this just prevents stale games from lingering in memory and prevents
      // the opponent from being stuck referencing a half-empty game).
      if(oldGameId && games[oldGameId]){
        const g=games[oldGameId];
        const oppId = clientId===g.p1 ? g.p2 : g.p1;
        // Only fully delete once BOTH players have left, so the opponent
        // can still see/interact with their own result screen if they're slower.
        if(clients[oppId] && clients[oppId].gameId===oldGameId){
          // Opponent hasn't left yet — leave the game object alive for them,
          // just detach this player from it.
        } else {
          delete games[oldGameId];
        }
      }
      broadcastLobby();
      send(clientId,{type:'go_lobby'});
    }
    else if (msg.type==='request_lobby') {
      const c=clients[clientId]; if(!c||c.status==='playing') return;
      const w=Object.entries(clients).filter(([,c2])=>c2.status==='waiting').map(([id,c2])=>({id,name:c2.name}));
      const o=Object.entries(clients).map(([id,c2])=>({id,name:c2.name,status:c2.status}));
      send(clientId,{type:'lobby_update',waiting:w,online:o,photosMeta:photos.map(p=>({id:p.id,name:p.name})),myStatus:c.status});
    }
    else if (msg.type==='ping') { /* keepalive */ }
    else if (msg.type==='request_photos') {
      // Client is missing photo data — resend it
      sendPhotos(clientId);
    }
    else if (msg.type==='admin_get_data') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'admin_gate_fail'}); return; }
      send(clientId,{type:'admin_data',allPhotos,presets:presets.map(p=>({id:p.id,name:p.name,photoIds:p.photoIds,count:p.photoIds.length}))});
    }
    else if (msg.type==='admin_photos') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      allPhotos=(msg.photos||[]).map((p,i)=>({id:i,src:p.src||p,name:p.name||''}));
      photos=allPhotos; // reset active to full library
      savePhotos();
      // Push new photos to all non-playing clients
      Object.entries(clients).forEach(([id,c])=>{ if(c.status!=='playing') sendPhotos(id); });
      broadcastLobby();
      send(clientId,{type:'admin_ok',text:`${allPhotos.length} photos saved!`});
    }
    else if (msg.type==='admin_activate_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      // Resolve the base pool of photos for whichever preset (or 'all') was picked
      let basePool;
      if(msg.presetId==='all') {
        basePool = allPhotos;
      } else {
        const pr=presets.find(p=>p.id===msg.presetId);
        if(!pr) { send(clientId,{type:'error',text:'Preset not found.'}); return; }
        basePool = pr.photoIds.map(pid=>allPhotos.find(p=>p.id===pid)).filter(Boolean);
      }
      // Randomizer is now an independent toggle that layers on top of
      // whichever base set was chosen — works for 'all' or any preset.
      // If the requested random count is >= the pool size, just use the
      // whole pool (shown in original order) instead of trimming it.
      if (msg.randomize && msg.count && msg.count < basePool.length) {
        photos = shuffle(basePool).slice(0, msg.count).map((p,i)=>({...p,id:i}));
      } else {
        photos = basePool.map((p,i)=>({...p,id:i}));
      }
      // Persist the active selection (including randomizer state) so it survives restarts
      saveActive(msg.presetId, photos.length, !!msg.randomize, msg.count||null);
      Object.entries(clients).forEach(([id,c])=>{ if(c.status!=='playing') sendPhotos(id); });
      broadcastLobby();
      console.log('Active game photos set to', photos.length, 'photos', msg.randomize ? `(randomized, requested ${msg.count})` : '');
      send(clientId,{type:'admin_ok',text:`Active set: ${photos.length} photos ready!`});
    }
    else if (msg.type==='admin_save_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      const ex=presets.find(p=>p.id===msg.preset.id);
      if(ex) Object.assign(ex,msg.preset);
      else presets.push({id:String(Date.now()),name:msg.preset.name,photoIds:msg.preset.photoIds});
      savePresets();
      send(clientId,{type:'presets_update',presets:presets.map(p=>({id:p.id,name:p.name,photoIds:p.photoIds,count:p.photoIds.length}))});
      send(clientId,{type:'admin_ok',text:'Preset saved!'});
    }
    else if (msg.type==='admin_delete_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      presets=presets.filter(p=>p.id!==msg.presetId); savePresets();
      send(clientId,{type:'presets_update',presets:presets.map(p=>({id:p.id,name:p.name,photoIds:p.photoIds,count:p.photoIds.length}))});
      send(clientId,{type:'admin_ok',text:'Preset deleted.'});
    }
    else if (msg.type==='admin_reset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      Object.keys(games).forEach(g=>delete games[g]);
      Object.keys(pendingChallenges).forEach(k=>delete pendingChallenges[k]);
      Object.entries(clients).forEach(([id,c])=>{ c.status='lobby'; c.gameId=null; send(id,{type:'force_lobby'}); });
      setTimeout(broadcastLobby,100);
      send(clientId,{type:'admin_ok',text:'Hard reset done.'});
    }
  });

  ws.on('close', ()=>handleDisconnect(clientId));
  ws.on('error', ()=>handleDisconnect(clientId));
});

// Heartbeat: ping every 30s, but give a generous 3-strikes grace period
// before actually disconnecting. Phones that lock/background throttle their
// JS timers and WebSocket pong handling (especially iOS Safari), so a single
// missed ping is normal and should NOT count as a disconnect — only treat
// the connection as dead after several consecutive missed pongs in a row
// (roughly 2-3 minutes of total silence).
const PING_INTERVAL_MS = 30000;
const MAX_MISSED_PINGS = 4; // ~2 minutes of no response before we give up
setInterval(()=>{
  Object.entries(clients).forEach(([id,c])=>{
    if(c.ws.readyState!==WebSocket.OPEN){ handleDisconnect(id); return; }
    c.missedPings = c.missedPings || 0;
    if(!c.ws.isAlive){
      c.missedPings++;
      if(c.missedPings >= MAX_MISSED_PINGS){
        console.log(`Client ${id} (${c.name}) unresponsive after ${MAX_MISSED_PINGS} pings — disconnecting`);
        c.ws.terminate();
        handleDisconnect(id);
        return;
      }
    } else {
      c.missedPings = 0; // got a pong (or a message) since last check — reset
    }
    c.ws.isAlive = false;
    try{ c.ws.ping(); }catch(e){}
  });
},PING_INTERVAL_MS);

server.listen(PORT,'0.0.0.0',()=>console.log(`Guess Who on port ${PORT}`));
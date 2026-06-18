const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'xzone';
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const PHOTOS_FILE  = path.join(DATA_DIR, 'photos.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');

let allPhotos = [];  // master library
let photos = [];     // active game set
let presets = [];
let clients = {};
let games = {};
let pendingChallenges = {};
let nextId = 1;
let nextGameId = 1;

try {
  if (fs.existsSync(PHOTOS_FILE)) {
    allPhotos = JSON.parse(fs.readFileSync(PHOTOS_FILE, 'utf8'));
    photos = allPhotos;
    console.log('Loaded', allPhotos.length, 'photos');
  }
} catch(e) { console.error(e.message); }

try {
  if (fs.existsSync(PRESETS_FILE)) {
    presets = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'));
  }
} catch(e) { console.error(e.message); }

function savePhotos()  { try { fs.writeFileSync(PHOTOS_FILE,  JSON.stringify(allPhotos)); } catch(e) { console.error(e.message); } }
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
  const photoIds = photos.map(p=>p.id); // just ids — client already has full photos
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
  games[gid] = {
    p1, p2, phase:'pick', turn:null, result:null, snipe:null,
    flippedThisTurn:{ [p1]:new Set(), [p2]:new Set() },
    players:{ [p1]:{secret:null,eliminated:new Set(),guessesLeft:3}, [p2]:{secret:null,eliminated:new Set(),guessesLeft:3} }
  };
  clients[p1].status='playing'; clients[p1].gameId=gid;
  clients[p2].status='playing'; clients[p2].gameId=gid;
  [p1,p2].forEach(pid => send(pid, {type:'matched',gameId:gid,opponentName:clients[pid===p1?p2:p1]?.name}));
  broadcastLobby();
  // Send full photos to both players immediately
  [p1,p2].forEach(pid => sendPhotos(pid));
  // Also resend photos just before game_state so cache is definitely warm
  setTimeout(() => {
    if(!games[gid]) return;
    [p1,p2].forEach(pid => sendPhotos(pid));
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
    g.flippedThisTurn[responderId]=new Set();
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

function handleDisconnect(clientId) {
  const c = clients[clientId]; if(!c) return;
  if (c.gameId) {
    const g = games[c.gameId];
    if (g) {
      const oppId = clientId===g.p1?g.p2:g.p1;
      if(clients[oppId]) { clients[oppId].status='lobby'; clients[oppId].gameId=null; send(oppId,{type:'opponent_left'}); }
      delete games[c.gameId];
    }
  }
  delete pendingChallenges[clientId];
  Object.keys(pendingChallenges).forEach(k=>{ if(pendingChallenges[k]?.targetId===clientId) delete pendingChallenges[k]; });
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
      clients[clientId] = {ws, name:(msg.name||'Player').slice(0,20), status:'lobby', gameId:null};
      // Send full photos immediately on join
      send(clientId, {type:'welcome', clientId});
      sendPhotos(clientId);
      const w=Object.entries(clients).filter(([,c])=>c.status==='waiting').map(([id,c])=>({id,name:c.name}));
      const o=Object.entries(clients).map(([id,c])=>({id,name:c.name,status:c.status}));
      send(clientId, {type:'lobby_update',waiting:w,online:o,photosMeta:photos.map(p=>({id:p.id,name:p.name})),myStatus:'lobby'});
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
      if(photos.length<2) { send(clientId,{type:'error',text:'Admin needs to upload photos first.'}); return; }
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
      const g=games[c.gameId]; if(!g||g.phase!=='playing'||g.turn!==clientId) return;
      const elim=g.players[clientId].eliminated, ft=g.flippedThisTurn[clientId];
      if(elim.has(msg.photoId)) { if(ft.has(msg.photoId)){ elim.delete(msg.photoId); ft.delete(msg.photoId); } }
      else { elim.add(msg.photoId); ft.add(msg.photoId); }
      const remaining=photos.filter(p=>!elim.has(p.id));
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
      g.turn=next; g.flippedThisTurn[next]=new Set();
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
      c.status='lobby'; c.gameId=null; broadcastLobby(); send(clientId,{type:'go_lobby'});
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
      send(clientId,{type:'admin_data',allPhotos,presets});
    }
    else if (msg.type==='admin_photos') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      allPhotos=(msg.photos||[]).map((p,i)=>({id:i,src:p.src||p,name:p.name||''}));
      photos=allPhotos; savePhotos();
      // Push new photos to all non-playing clients
      Object.entries(clients).forEach(([id,c])=>{ if(c.status!=='playing') sendPhotos(id); });
      broadcastLobby();
      send(clientId,{type:'admin_ok',text:`${allPhotos.length} photos saved!`});
    }
    else if (msg.type==='admin_activate_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      if(msg.presetId==='all') { photos=allPhotos; }
      else if(msg.presetId==='random') {
        const n=Math.min(msg.count||25,allPhotos.length);
        photos=shuffle(allPhotos).slice(0,n).map((p,i)=>({...p,id:i}));
      } else {
        const pr=presets.find(p=>p.id===msg.presetId);
        if(!pr) { send(clientId,{type:'error',text:'Preset not found.'}); return; }
        photos=pr.photoIds.map(pid=>allPhotos.find(p=>p.id===pid)).filter(Boolean).map((p,i)=>({...p,id:i}));
      }
      Object.entries(clients).forEach(([id,c])=>{ if(c.status!=='playing') sendPhotos(id); });
      broadcastLobby();
      send(clientId,{type:'admin_ok',text:'Game photos updated!'});
    }
    else if (msg.type==='admin_save_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      const ex=presets.find(p=>p.id===msg.preset.id);
      if(ex) Object.assign(ex,msg.preset);
      else presets.push({id:String(Date.now()),name:msg.preset.name,photoIds:msg.preset.photoIds});
      savePresets();
      send(clientId,{type:'presets_update',presets:presets.map(p=>({id:p.id,name:p.name,count:p.photoIds.length}))});
      send(clientId,{type:'admin_ok',text:'Preset saved!'});
    }
    else if (msg.type==='admin_delete_preset') {
      if(msg.password!==ADMIN_PASSWORD) { send(clientId,{type:'error',text:'Wrong password.'}); return; }
      presets=presets.filter(p=>p.id!==msg.presetId); savePresets();
      send(clientId,{type:'presets_update',presets:presets.map(p=>({id:p.id,name:p.name,count:p.photoIds.length}))});
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

// Ping every 20s to keep connections alive
setInterval(()=>{
  Object.entries(clients).forEach(([id,c])=>{
    if(c.ws.readyState!==WebSocket.OPEN){ handleDisconnect(id); return; }
    if(!c.ws.isAlive){ c.ws.terminate(); handleDisconnect(id); return; }
    c.ws.isAlive=false;
    try{ c.ws.ping(); }catch(e){}
  });
},20000);

server.listen(PORT,'0.0.0.0',()=>console.log(`Guess Who on port ${PORT}`));
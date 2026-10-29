/* =====================================================================
   HÜCRE ARENA — Gerçek zamanlı çok oyunculu (PvP) hücre oyunu
   Sunucu: Node.js + Express + Socket.IO
   Tüm oyun mantığı sunucuda çalışır (authoritative server).
   ===================================================================== */

'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e6
});

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

/* ------------------------- Oyun sabitleri ------------------------- */
const W = 3600;                 // dünya genişliği
const H = 3600;                 // dünya yüksekliği
const DT = 1 / 60;              // fizik adımı (saniye)
const SNAPSHOT_HZ = 20;         // saniyede kaç durum paketi

const START_MASS = 22;          // başlangıç kütlesi
const MIN_SPLIT_MASS = 36;      // bölünmek için gereken min kütle
const MAX_CELLS = 16;           // oyuncu başına maksimum hücre
const MERGE_TIME = 14;          // bölündükten sonra birleşme bekleme süresi (sn)
const FOOD_TARGET = 1500;       // haritadaki toplam yem sayısı
const VIRUS_TARGET = 20;        // dikenli virüs sayısı
const EJECT_MASS = 14;          // fırlatılan kütlenin büyüklüğü
const EJECT_COST = 20;          // fırlatmanın oyuncuya maliyeti
const BOT_COUNT = Number(process.env.BOTS || 8); // yalnız kalmayın diye botlar
const MAX_MASS = 25000;

const COLORS = [
  '#ff4d8d', '#7c3aed', '#2fd4ff', '#ffd23f', '#6ff0c0',
  '#ff8a3d', '#4f7dff', '#ff6b6b', '#b06bff', '#3ddc97'
];
const FOOD_COLORS = [
  '#ff4d8d', '#7c3aed', '#2fd4ff', '#ffd23f', '#6ff0c0',
  '#ff8a3d', '#4f7dff', '#ff6b6b', '#b06bff', '#3ddc97', '#ffffff'
];

const BOT_NAMES = [
  'Piksel', 'Zeytin', 'Kaptan', 'Nova', 'Bulut', 'Misket', 'Turbo',
  'Karamel', 'Fırtına', 'Limon', 'Gölge', 'Mars', 'Kivi', 'Roket',
  'Şeker', 'Vatoz', 'Maden', 'Kobalt'
];

/* ------------------------- Yardımcılar ------------------------- */
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const nowSec = () => Date.now() / 1000;

/** Kütle -> yarıçap */
const rOf = (m) => Math.sqrt(m) * 4;
/** Kütle -> hız (px/sn): büyüdükçe yavaşlarsın */
const speedOf = (m) => 250 * Math.pow(Math.max(m, 1), -0.22) + 25;

/* ------------------------- Durum ------------------------- */
const players = new Map();  // id -> player
const food = new Map();     // id -> {id,x,y,c}
const viruses = new Map();  // id -> {id,x,y,m}
const pellets = new Map();  // fırlatılmış kütleler: id -> {id,x,y,vx,vy,m,c,owner,until}

let uid = 1;
const nextId = () => 'o' + uid++;

/* ------------------------- Uzamsal ızgara ------------------------- */
class Grid {
  constructor(size) {
    this.size = size;
    this.map = new Map();
  }
  clear() { this.map.clear(); }
  add(obj) {
    const k = ((obj.x / this.size) | 0) + ':' + ((obj.y / this.size) | 0);
    let arr = this.map.get(k);
    if (!arr) { arr = []; this.map.set(k, arr); }
    arr.push(obj);
  }
  near(x, y, r, cb) {
    const s = this.size;
    const x0 = ((x - r) / s) | 0, x1 = ((x + r) / s) | 0;
    const y0 = ((y - r) / s) | 0, y1 = ((y + r) / s) | 0;
    for (let i = x0; i <= x1; i++) {
      for (let j = y0; j <= y1; j++) {
        const arr = this.map.get(i + ':' + j);
        if (!arr) continue;
        for (let n = 0; n < arr.length; n++) cb(arr[n]);
      }
    }
  }
}

const foodGrid = new Grid(220);
const cellGrid = new Grid(260);

/* ------------------------- Varlık üretimi ------------------------- */
function spawnFood() {
  const f = {
    id: nextId(),
    x: rand(30, W - 30),
    y: rand(30, H - 30),
    c: pick(FOOD_COLORS)
  };
  food.set(f.id, f);
  io.emit('food:add', [f.id, Math.round(f.x), Math.round(f.y), f.c]);
  return f;
}

function spawnVirus() {
  const v = {
    id: nextId(),
    x: rand(300, W - 300),
    y: rand(300, H - 300),
    m: rand(110, 150)
  };
  viruses.set(v.id, v);
  return v;
}

for (let i = 0; i < FOOD_TARGET; i++) {
  const f = {
    id: nextId(), x: rand(30, W - 30), y: rand(30, H - 30), c: pick(FOOD_COLORS)
  };
  food.set(f.id, f);
}
for (let i = 0; i < VIRUS_TARGET; i++) spawnVirus();

/* ------------------------- Oyuncular ------------------------- */
function createPlayer(id, name, isBot = false) {
  const p = {
    id,
    name: (name || 'Misafir').toString().slice(0, 14).trim() || 'Misafir',
    color: pick(COLORS),
    isBot,
    cells: [],
    target: { x: W / 2, y: H / 2 },
    dead: false,
    best: START_MASS,
    wander: { x: W / 2, y: H / 2, until: 0 }
  };
  respawn(p);
  players.set(id, p);
  return p;
}

function respawn(p) {
  // Kalabalıktan uzak bir noktada doğ
  let bx = W / 2, by = H / 2, bestScore = -1;
  for (let i = 0; i < 8; i++) {
    const x = rand(250, W - 250), y = rand(250, H - 250);
    let d = 1e9;
    for (const q of players.values()) {
      if (q === p || q.dead) continue;
      for (const c of q.cells) {
        d = Math.min(d, Math.hypot(c.x - x, c.y - y));
      }
    }
    if (d > bestScore) { bestScore = d; bx = x; by = y; }
  }
  p.cells = [{ x: bx, y: by, m: START_MASS, sx: 0, sy: 0, mergeAt: 0 }];
  p.target = { x: bx, y: by };
  p.dead = false;
  p.best = Math.max(p.best, START_MASS);
}

/* ------------------------- Bölünme / fırlatma ------------------------- */
function doSplit(p) {
  if (p.dead) return;
  const list = p.cells.slice();
  let room = MAX_CELLS - p.cells.length;
  if (room <= 0) return;

  const t = p.target;
  for (const c of list) {
    if (room <= 0) break;
    if (c.m < MIN_SPLIT_MASS) continue;

    const dx = t.x - c.x, dy = t.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = dx / d, ny = dy / d;

    const half = c.m / 2;
    c.m = half;
    c.mergeAt = nowSec() + MERGE_TIME;

    p.cells.push({
      x: c.x + nx * 2,
      y: c.y + ny * 2,
      m: half,
      sx: nx * 780,
      sy: ny * 780,
      mergeAt: nowSec() + MERGE_TIME
    });
    room--;
  }
}

function doEject(p) {
  if (p.dead) return;
  const t = p.target;
  for (const c of p.cells) {
    if (c.m < 35) continue;

    const dx = t.x - c.x, dy = t.y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    const nx = dx / d, ny = dy / d;

    c.m -= EJECT_COST;
    const r = rOf(c.m);
    const pellet = {
      id: nextId(),
      x: c.x + nx * (r + 6),
      y: c.y + ny * (r + 6),
      vx: nx * 720,
      vy: ny * 720,
      m: EJECT_MASS,
      c: p.color,
      owner: p.id,
      until: nowSec() + 2.5
    };
    pellets.set(pellet.id, pellet);
  }
}

/* ------------------------- Bot yapay zekâsı ------------------------- */
function botThink(p, dt) {
  const big = p.cells.reduce((a, c) => (c.m > a.m ? c : a), p.cells[0]);
  if (!big) return;
  const bm = big.m;

  let prey = null, preyScore = -Infinity;
  let threat = null, threatD = Infinity;

  for (const q of players.values()) {
    if (q === p || q.dead) continue;
    for (const c of q.cells) {
      const d = Math.hypot(c.x - big.x, c.y - big.y);
      if (d > 1500) continue;
      if (c.m * 1.35 < bm) {
        const s = c.m / (d + 60);
        if (s > preyScore) { preyScore = s; prey = c; }
      } else if (c.m > bm * 1.35 && d < 460) {
        if (d < threatD) { threatD = d; threat = c; }
      }
    }
  }

  if (threat) {
    // Kaç: tehdidin tersine, duvara sıkışmayacak şekilde
    const dx = big.x - threat.x, dy = big.y - threat.y;
    const d = Math.hypot(dx, dy) || 1;
    p.target.x = clamp(big.x + (dx / d) * 900, 80, W - 80);
    p.target.y = clamp(big.y + (dy / d) * 900, 80, H - 80);
    return;
  }

  if (prey) {
    p.target.x = prey.x;
    p.target.y = prey.y;
    return;
  }

  // Yakında yem ara
  let bestFood = null, bestD = Infinity;
  foodGrid.near(big.x, big.y, 700, (f) => {
    const d = Math.hypot(f.x - big.x, f.y - big.y);
    if (d < bestD) { bestD = d; bestFood = f; }
  });
  if (bestFood) {
    p.target.x = bestFood.x;
    p.target.y = bestFood.y;
    return;
  }

  // Rastgele gezin
  if (nowSec() > p.wander.until) {
    p.wander = { x: rand(200, W - 200), y: rand(200, H - 200), until: nowSec() + rand(3, 7) };
  }
  p.target.x = p.wander.x;
  p.target.y = p.wander.y;
}

/* ------------------------- Fizik / oyun döngüsü ------------------------- */
function update(dt) {
  const now = nowSec();

  /* Yem ızgarası (botlar da kullanıyor) */
  foodGrid.clear();
  for (const f of food.values()) foodGrid.add(f);

  /* 1) Botlar düşünsün */
  for (const p of players.values()) {
    if (p.isBot && !p.dead) botThink(p, dt);
  }

  /* 2) Hücre hareketi */
  for (const p of players.values()) {
    if (p.dead) continue;
    for (const c of p.cells) {
      const r = rOf(c.m);
      const dx = p.target.x - c.x;
      const dy = p.target.y - c.y;
      const d = Math.hypot(dx, dy) || 1;
      const sp = speedOf(c.m);
      const f = Math.min(1, d / (r * 0.9 + 12));

      c.x += (dx / d) * sp * f * dt + c.sx * dt;
      c.y += (dy / d) * sp * f * dt + c.sy * dt;

      // bölünme itkisi sönümü
      const decay = Math.pow(0.06, dt);
      c.sx *= decay;
      c.sy *= decay;
      if (Math.abs(c.sx) < 2) c.sx = 0;
      if (Math.abs(c.sy) < 2) c.sy = 0;

      c.x = clamp(c.x, r, W - r);
      c.y = clamp(c.y, r, H - r);
    }
    separateAndMerge(p, now);
  }

  /* 3) Fırlatılmış kütleler */
  for (const pel of pellets.values()) {
    pel.x += pel.vx * dt;
    pel.y += pel.vy * dt;
    const dec = Math.pow(0.02, dt);
    pel.vx *= dec;
    pel.vy *= dec;
    const r = rOf(pel.m);
    if (pel.x < r || pel.x > W - r) { pel.vx *= -0.5; pel.x = clamp(pel.x, r, W - r); }
    if (pel.y < r || pel.y > H - r) { pel.vy *= -0.5; pel.y = clamp(pel.y, r, H - r); }
  }

  /* 4) Hücre ızgarası (yeme kontrolleri için) */
  cellGrid.clear();
  let idx = 0;
  for (const p of players.values()) {
    if (p.dead) continue;
    for (const c of p.cells) {
      c.__i = idx++;
      c.__p = p.id;
      cellGrid.add(c);
    }
  }

  /* 5) Yem yeme */
  for (const p of players.values()) {
    if (p.dead) continue;
    for (const c of p.cells) {
      const r = rOf(c.m);
      const rr = r * r;
      foodGrid.near(c.x, c.y, r, (f) => {
        if (f.dead) return;
        const dx = f.x - c.x, dy = f.y - c.y;
        if (dx * dx + dy * dy < rr) {
          f.dead = true;
          food.delete(f.id);
          c.m = Math.min(MAX_MASS, c.m + 1.6);
          io.emit('food:remove', f.id);
          spawnFood();
        }
      });
    }
  }

  /* 6) Fırlatılmış kütleyi toplama */
  for (const pel of pellets.values()) {
    cellGrid.near(pel.x, pel.y, rOf(pel.m), (c) => {
      if (c.__p === pel.owner && now < pel.until) return; // kendi attığını hemen yiyemez
      const r = rOf(c.m);
      const d = Math.hypot(pel.x - c.x, pel.y - c.y);
      if (d < r) {
        c.m = Math.min(MAX_MASS, c.m + pel.m * 0.85);
        pellets.delete(pel.id);
      }
    });
    if (now > pel.until + 12) pellets.delete(pel.id);
  }

  /* 7) Virüsler: büyük hücre patlar */
  for (const p of players.values()) {
    if (p.dead) continue;
    for (const c of p.cells) {
      for (const v of viruses.values()) {
        const rv = rOf(v.m);
        const d = Math.hypot(v.x - c.x, v.y - c.y);
        if (d < rOf(c.m) - rv * 0.4 && c.m > v.m * 1.25) {
          popCell(p, c);
          // virüs başka yere taşınsın
          v.x = rand(300, W - 300);
          v.y = rand(300, H - 300);
        }
      }
    }
  }

  /* 8) Hücre-hücre yeme (PvP) */
  for (const p of players.values()) {
    if (p.dead) continue;
    for (const c of p.cells) {
      if (c.m <= 0) continue;
      cellGrid.near(c.x, c.y, rOf(c.m), (o) => {
        if (c.__p === o.__p || o.m <= 0 || c.m <= 0) return;
        if (c.__i >= o.__i) return; // çift kontrolü engelle
        const ra = rOf(c.m), rb = rOf(o.m);
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        if (c.m > o.m * 1.2 && d < ra - rb * 0.5) {
          c.m = Math.min(MAX_MASS, c.m + o.m);
          o.m = 0;
        } else if (o.m > c.m * 1.2 && d < rb - ra * 0.5) {
          o.m = Math.min(MAX_MASS, o.m + c.m);
          c.m = 0;
        }
      });
    }
  }

  /* 9) Temizlik ve ölüm */
  for (const p of players.values()) {
    p.cells = p.cells.filter((c) => c.m > 0);
    if (!p.dead) {
      for (const c of p.cells) p.best = Math.max(p.best, c.m);
      if (p.cells.length === 0) {
        p.dead = true;
        if (p.isBot) {
          setTimeout(() => { if (players.has(p.id) && p.dead) respawn(p); }, 1200);
        } else {
          io.to(p.id).emit('dead', { best: Math.round(p.best) });
        }
      }
    }
  }

  /* 10) Fırlatılmış kütle tavanı */
  if (pellets.size > 400) {
    let n = 0;
    for (const k of pellets.keys()) {
      if (n++ > 60) break;
      pellets.delete(k);
    }
  }
}

/** Aynı oyuncunun hücreleri: itme + birleşme */
function separateAndMerge(p, now) {
  const cs = p.cells;
  for (let i = 0; i < cs.length; i++) {
    for (let j = i + 1; j < cs.length; j++) {
      const a = cs[i], b = cs[j];
      if (a.m <= 0 || b.m <= 0) continue;
      const ra = rOf(a.m), rb = rOf(b.m);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 0.01;

      // birleşme
      if (now > a.mergeAt && now > b.mergeAt) {
        if (d < Math.max(ra, rb) * 0.85) {
          const big = a.m >= b.m ? a : b;
          const small = a.m >= b.m ? b : a;
          big.m = Math.min(MAX_MASS, big.m + small.m);
          small.m = 0;
          continue;
        }
      }
      // itme
      const minD = ra + rb;
      if (d < minD) {
        const push = (minD - d) / 2;
        const nx = dx / d, ny = dy / d;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
    }
  }
  p.cells = p.cells.filter((c) => c.m > 0);
  for (const c of p.cells) {
    const r = rOf(c.m);
    c.x = clamp(c.x, r, W - r);
    c.y = clamp(c.y, r, H - r);
  }
}

/** Virüse çarpan hücreyi parçala */
function popCell(p, c) {
  const room = MAX_CELLS - p.cells.length;
  if (room < 2) return;
  const pieces = Math.min(6, room);
  const massEach = c.m / (pieces + 1);
  c.m = massEach;

  for (let i = 0; i < pieces; i++) {
    const ang = (Math.PI * 2 * i) / pieces + Math.random() * 0.4;
    p.cells.push({
      x: c.x + Math.cos(ang) * 6,
      y: c.y + Math.sin(ang) * 6,
      m: massEach,
      sx: Math.cos(ang) * 620,
      sy: Math.sin(ang) * 620,
      mergeAt: nowSec() + MERGE_TIME
    });
  }
}

/* ------------------------- Ana döngü ------------------------- */
let last = Date.now();
let acc = 0;
const SNAP_MS = 1000 / SNAPSHOT_HZ;
let snapAcc = 0;

function loop() {
  const t = Date.now();
  let delta = (t - last) / 1000;
  last = t;
  if (delta > 0.25) delta = 0.25; // sekme arkaplandaysa sıçramayı önle
  acc += delta;
  snapAcc += delta;

  let guard = 0;
  while (acc >= DT && guard++ < 8) {
    update(DT);
    acc -= DT;
  }

  if (snapAcc * 1000 >= SNAP_MS) {
    snapAcc = 0;
    broadcast();
  }
}

function broadcast() {
  const out = [];
  for (const p of players.values()) {
    if (p.dead || p.cells.length === 0) continue;
    const cells = [];
    for (const c of p.cells) {
      cells.push([Math.round(c.x), Math.round(c.y), Math.round(c.m)]);
    }
    out.push([p.id, p.name, p.color, cells]);
  }

  // skor tablosu
  const lb = [];
  for (const p of players.values()) {
    if (p.dead) continue;
    let m = 0;
    for (const c of p.cells) m += c.m;
    lb.push([p.name, Math.round(m), p.color, p.isBot ? 1 : 0]);
  }
  lb.sort((a, b) => b[1] - a[1]);

  // virüsler ve fırlatılmış kütleler
  const vs = [];
  for (const v of viruses.values()) {
    vs.push([Math.round(v.x), Math.round(v.y), Math.round(v.m)]);
  }
  const ps = [];
  for (const pel of pellets.values()) {
    ps.push([Math.round(pel.x), Math.round(pel.y), Math.round(pel.m), pel.c]);
  }

  io.volatile.emit('state', {
    p: out,
    lb: lb.slice(0, 10),
    v: vs,
    e: ps
  });
}

setInterval(loop, 1000 / 60);

/* ------------------------- Socket olayları ------------------------- */
io.on('connection', (socket) => {
  const initFood = [];
  for (const f of food.values()) {
    initFood.push([f.id, Math.round(f.x), Math.round(f.y), f.c]);
  }

  socket.emit('init', {
    id: socket.id,
    w: W,
    h: H,
    food: initFood
  });

  socket.on('join', (name) => {
    if (players.has(socket.id)) return;
    createPlayer(socket.id, name, false);
  });

  socket.on('input', (data) => {
    const p = players.get(socket.id);
    if (!p || p.dead) return;
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
    p.target.x = clamp(data.x, 0, W);
    p.target.y = clamp(data.y, 0, H);
  });

  socket.on('split', () => {
    const p = players.get(socket.id);
    if (p) doSplit(p);
  });

  socket.on('eject', () => {
    const p = players.get(socket.id);
    if (p) doEject(p);
  });

  socket.on('respawn', () => {
    const p = players.get(socket.id);
    if (!p) return;
    p.best = START_MASS;
    respawn(p);
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
  });
});

/* ------------------------- Botları doldur ------------------------- */
function fillBots() {
  let bots = 0;
  const used = new Set();
  for (const p of players.values()) {
    if (p.isBot) { bots++; used.add(p.name); }
  }
  while (bots < BOT_COUNT) {
    const free = BOT_NAMES.filter((n) => !used.has(n));
    const name = free.length ? pick(free) : pick(BOT_NAMES) + ' ' + (bots + 1);
    used.add(name);
    createPlayer('bot' + nextId(), name, true);
    bots++;
  }
}
fillBots();
setInterval(fillBots, 5000);

/* ------------------------- Takip / temizlik ------------------------- */
setInterval(() => {
  const now = nowSec();
  for (const [id, pel] of pellets) {
    if (now > pel.until + 20) pellets.delete(id);
  }
  if (food.size < FOOD_TARGET - 60) {
    for (let i = 0; i < 40; i++) spawnFood();
  }
}, 3000);

server.listen(PORT, () => {
  console.log(`\n  🎮 Hücre Arena çalışıyor:  http://localhost:${PORT}`);
  console.log(`  🌍 Dünya: ${W}x${H} · Bot: ${BOT_COUNT}\n`);
});

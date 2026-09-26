'use strict';
const express = require('express');
const session = require('express-session');
const { DatabaseSync } = require('node:sqlite');
const moment = require('moment');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// ── 定数 ─────────────────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'lottery.db');
const AUDIT_LOG = process.env.AUDIT_LOG || path.join(__dirname, 'data', 'audit.log');

// ── DB ───────────────────────────────────────────────────────────────
if (DB_PATH !== ':memory:' && !fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'applicant'
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organizer_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    venue TEXT NOT NULL,
    held_on TEXT NOT NULL,
    entry_start TEXT NOT NULL,
    entry_end TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    entry_limit INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'open'
  );
  CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  );
`);

function hashPassword(plain, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + '$' + crypto.scryptSync(plain, salt, 32).toString('hex');
}
function verifyPassword(plain, stored) {
  const [salt] = stored.split('$');
  return crypto.timingSafeEqual(Buffer.from(hashPassword(plain, salt)), Buffer.from(stored));
}

if (db.prepare('SELECT COUNT(*) AS c FROM users').get().c === 0) {
  const addUser = db.prepare(
    'INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)'
  );
  addUser.run('yamada', hashPassword('yamada-pass'), '山田 太郎', 'applicant');
  addUser.run('suzuki', hashPassword('suzuki-pass'), '鈴木 花子', 'applicant');
  addUser.run('tanaka', hashPassword('tanaka-pass'), '田中 興行', 'organizer');
  addUser.run('sato', hashPassword('sato-pass'), '佐藤プロモーション', 'organizer');

  const addEvent = db.prepare(`
    INSERT INTO events (organizer_id, name, venue, held_on, entry_start, entry_end, capacity, entry_limit, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const d = n => moment().add(n, 'days').format('YYYY-MM-DD');
  addEvent.run(3, '春風ロックフェス 2026', '幕張メッセ', d(60), d(-3), d(14), 200, 2, 'open');
  addEvent.run(3, '真夏のジャズナイト', 'ブルーノート東京', d(45), d(-1), d(10), 80, 2, 'open');
  addEvent.run(4, '劇団かもめ 冬公演', '新国立劇場', d(30), d(-20), d(-5), 120, 4, 'drawn');

  const addEntry = db.prepare(
    'INSERT INTO entries (event_id, user_id, quantity, contact, result, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const now = moment().format('YYYY-MM-DD HH:mm:ss');
  addEntry.run(1, 1, 2, 'yamada@example.com / 090-1111-2222', 'pending', now);
  addEntry.run(2, 1, 1, 'yamada@example.com / 090-1111-2222', 'pending', now);
  addEntry.run(1, 2, 1, 'suzuki@example.com / 080-3333-4444', 'pending', now);
  addEntry.run(3, 2, 4, 'suzuki@example.com / 080-3333-4444', 'won', now);
}

// ── App ──────────────────────────────────────────────────────────────
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'lottery-app-dev-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: false },
}));

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login?msg=' + encodeURIComponent('ログインしてください'));
  }
  next();
}

function requireOrganizer(req, res, next) {
  if (req.session.user.role !== 'organizer') {
    return res.status(403).render('error', { message: '主催者のみが利用できる画面です' });
  }
  next();
}

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.moment = moment;
  next();
});

// ── 認証 ─────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { msg: req.query.msg || '' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.redirect('/login?msg=' + encodeURIComponent('ユーザー名またはパスワードが違います'));
  }
  req.session.user = {
    id: user.id, username: user.username,
    display_name: user.display_name, role: user.role,
  };
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login?msg=' + encodeURIComponent('ログアウトしました')));
});

// ── 抽選イベント一覧 ─────────────────────────────────────────────────
app.get('/', requireLogin, (req, res) => {
  const { keyword, status } = req.query;

  let sql = 'SELECT * FROM events WHERE 1 = 1';
  if (keyword) sql += " AND (name LIKE '%" + keyword + "%' OR venue LIKE '%" + keyword + "%')";
  if (status) sql += " AND status = '" + status + "'";
  sql += ' ORDER BY entry_end ASC';
  const events = db.prepare(sql).all();

  res.render('index', {
    events,
    filter: { keyword: keyword || '', status: status || '' },
    msg: req.query.msg || '',
  });
});

// ── イベント詳細と応募 ───────────────────────────────────────────────
app.get('/events/:id', requireLogin, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) {
    return res.status(404).render('error', { message: 'イベントが見つかりません' });
  }
  const applied = db.prepare(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM entries WHERE event_id = ? AND user_id = ?'
  ).get(event.id, req.session.user.id).total;

  res.render('event', { event, applied, msg: req.query.msg || '' });
});

app.post('/events/:id/entries', requireLogin, async (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) {
    return res.status(404).render('error', { message: 'イベントが見つかりません' });
  }
  const back = m => res.redirect(`/events/${event.id}?msg=` + encodeURIComponent(m));

  const quantity = parseInt(req.body.quantity, 10);
  const contact = (req.body.contact || '').trim();
  const userId = req.session.user.id;

  if (event.status !== 'open') return back('このイベントは受付を終了しています');
  const today = moment().format('YYYY-MM-DD');
  if (!moment(today).isBetween(event.entry_start, event.entry_end, 'day', '[]')) {
    return back('応募期間外です');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) return back('口数は1以上で入力してください');
  if (!contact) return back('連絡先を入力してください');

  // 同一イベントへの応募は1人あたり entry_limit 口まで
  const applied = db.prepare(
    'SELECT COALESCE(SUM(quantity), 0) AS total FROM entries WHERE event_id = ? AND user_id = ?'
  ).get(event.id, userId).total;
  if (applied + quantity > event.entry_limit) {
    return back(`応募は1人あたり${event.entry_limit}口までです（応募済み: ${applied}口）`);
  }

  // 応募の証跡をディスクへ確実に書き出してから受け付ける
  const audit = await fs.promises.open(AUDIT_LOG, 'a');
  await audit.write(
    `${moment().format('YYYY-MM-DD HH:mm:ss')}\tevent=${event.id}\tuser=${userId}\tqty=${quantity}\n`
  );
  await audit.sync();
  await audit.close();

  db.prepare(
    'INSERT INTO entries (event_id, user_id, quantity, contact, result, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(event.id, userId, quantity, contact, 'pending', moment().format('YYYY-MM-DD HH:mm:ss'));

  res.redirect('/entries?msg=' + encodeURIComponent('応募を受け付けました'));
});

// ── 応募状況の確認 ───────────────────────────────────────────────────
app.get('/entries', requireLogin, (req, res) => {
  const entries = db.prepare(`
    SELECT entries.*, events.name AS event_name, events.held_on, events.status AS event_status
      FROM entries JOIN events ON events.id = entries.event_id
     WHERE entries.user_id = ?
     ORDER BY entries.created_at DESC
  `).all(req.session.user.id);
  res.render('entries', { entries, msg: req.query.msg || '' });
});

app.get('/entries/:id', requireLogin, (req, res) => {
  const entry = db.prepare(`
    SELECT entries.*, events.name AS event_name, events.venue, events.held_on,
           events.status AS event_status, users.display_name AS applicant
      FROM entries
      JOIN events ON events.id = entries.event_id
      JOIN users ON users.id = entries.user_id
     WHERE entries.id = ?
  `).get(req.params.id);

  if (!entry) {
    return res.status(404).render('error', { message: '応募が見つかりません' });
  }
  res.render('entry', { entry });
});

// ── 主催者向け ───────────────────────────────────────────────────────
app.get('/admin/events/:id', requireLogin, requireOrganizer, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) {
    return res.status(404).render('error', { message: 'イベントが見つかりません' });
  }
  const entries = db.prepare(`
    SELECT entries.*, users.display_name AS applicant
      FROM entries JOIN users ON users.id = entries.user_id
     WHERE entries.event_id = ?
     ORDER BY entries.created_at ASC
  `).all(event.id);
  const total = entries.reduce((sum, e) => sum + e.quantity, 0);
  res.render('admin', { event, entries, total, msg: req.query.msg || '' });
});

app.post('/admin/events/:id/draw', requireLogin, requireOrganizer, (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) {
    return res.status(404).render('error', { message: 'イベントが見つかりません' });
  }

  const entries = db.prepare('SELECT * FROM entries WHERE event_id = ?').all(event.id);
  const shuffled = entries
    .map(e => ({ e, k: crypto.randomInt(1e9) }))
    .sort((a, b) => a.k - b.k)
    .map(x => x.e);

  const update = db.prepare('UPDATE entries SET result = ? WHERE id = ?');
  let remaining = event.capacity;
  for (const entry of shuffled) {
    if (entry.quantity <= remaining) {
      update.run('won', entry.id);
      remaining -= entry.quantity;
    } else {
      update.run('lost', entry.id);
    }
  }
  db.prepare("UPDATE events SET status = 'drawn' WHERE id = ?").run(event.id);

  res.redirect(`/admin/events/${event.id}?msg=` + encodeURIComponent('抽選を実施しました'));
});

// ── エラーハンドラー ─────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).render('error', { message: 'ページが見つかりません' });
});

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).render('error', { message: 'サーバーエラーが発生しました' });
});

if (require.main === module) {
  app.listen(process.env.PORT || 3000, () => console.log('lottery app listening on 3000'));
}
module.exports = app;

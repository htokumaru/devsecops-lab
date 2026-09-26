process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'test-only-session-secret';
process.env.AUDIT_LOG = require('path').join(require('os').tmpdir(), 'lottery-test-audit.log');

const request = require('supertest');
const app = require('../app');

async function loginAs(username, password) {
  const agent = request.agent(app);
  const res = await agent.post('/login').send(`username=${username}&password=${password}`);
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/');
  return agent;
}

describe('認証', () => {
  test('GET /login でログイン画面が表示される', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('ログイン');
  });

  test('未ログインで GET / はログイン画面へリダイレクトされる', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?msg=/);
  });

  test('誤ったパスワードではログインできない', async () => {
    const res = await request(app).post('/login').send('username=yamada&password=wrong');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/login\?msg=/);
  });

  test('正しい認証情報でログインできる', async () => {
    await loginAs('yamada', 'yamada-pass');
  });
});

describe('抽選一覧', () => {
  test('開催中のイベントが表示される', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    const res = await agent.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('春風ロックフェス 2026');
    expect(res.text).toContain('真夏のジャズナイト');
  });

  test('キーワードで絞り込める', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    const res = await agent.get('/').query({ keyword: 'ジャズ' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('真夏のジャズナイト');
    expect(res.text).not.toContain('春風ロックフェス 2026');
  });

  test('状態で絞り込める', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    const res = await agent.get('/').query({ status: 'drawn' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('劇団かもめ 冬公演');
    expect(res.text).not.toContain('春風ロックフェス 2026');
  });
});

describe('応募', () => {
  test('受付中のイベントに応募できる', async () => {
    const agent = await loginAs('suzuki', 'suzuki-pass');
    const res = await agent.post('/events/2/entries').send('quantity=2&contact=suzuki@example.com');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/entries\?msg=/);

    const list = await agent.get('/entries');
    expect(list.text).toContain('真夏のジャズナイト');
  });

  test('応募上限を超える口数は受け付けない', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    // 山田はイベント1に既に2口応募済み（上限2口）
    const res = await agent.post('/events/1/entries').send('quantity=1&contact=yamada@example.com');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/events\/1\?msg=/);
  });

  test('口数が0以下の応募は受け付けない', async () => {
    const agent = await loginAs('suzuki', 'suzuki-pass');
    const res = await agent.post('/events/1/entries').send('quantity=0&contact=suzuki@example.com');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/events\/1\?msg=/);
  });

  test('抽選済みのイベントには応募できない', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    const res = await agent.post('/events/3/entries').send('quantity=1&contact=yamada@example.com');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/events\/3\?msg=/);
  });
});

describe('主催者', () => {
  test('主催者は応募状況を確認できる', async () => {
    const agent = await loginAs('tanaka', 'tanaka-pass');
    const res = await agent.get('/admin/events/1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('主催者画面');
    expect(res.text).toContain('応募一覧');
  });

  test('応募者は主催者画面を開けない', async () => {
    const agent = await loginAs('yamada', 'yamada-pass');
    const res = await agent.get('/admin/events/1');
    expect(res.status).toBe(403);
  });

  test('抽選を実施すると当落が確定する', async () => {
    const agent = await loginAs('tanaka', 'tanaka-pass');
    const res = await agent.post('/admin/events/2/draw').send('');
    expect(res.status).toBe(302);

    const after = await agent.get('/admin/events/2');
    expect(after.text).toContain('抽選済み');
    expect(after.text).toMatch(/当選|落選/);
  });
});

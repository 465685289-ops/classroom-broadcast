import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const __filename = fileURLToPath(import.meta.url)
const __dirname0 = dirname(__filename)

const testDir = mkdtempSync(join(tmpdir(), 'shixing-workbench-sso-'))
process.env.SQLITE_FILE = join(testDir, 'test.db')
process.env.LEGACY_JSON_FILE = join(testDir, 'missing-data.json')
process.env.BACKUP_DIR = join(testDir, 'backups')
process.env.ADMIN_PASS = 'test-admin'

const WORKBENCH_USER_ID = 'wb-user-1'
const BROADCAST_USER_ID = 'shixing-user-1'

// 模拟工作台 /api/auth/me
const workbench = createServer((req, res) => {
  if (req.url === '/api/auth/sso-identity' && req.headers.authorization === 'Bearer wb-token-1') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: WORKBENCH_USER_ID,
      name: '贺老师',
      email: 'hetao@example.test',
      shixingUserId: `shixing:${BROADCAST_USER_ID}`,
    }))
    return
  }
  if (req.url === '/api/auth/sso-identity' && req.headers.authorization === 'Bearer wb-token-new') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'wb-user-new',
      name: '新老师',
      email: 'new-teacher@example.test',
    }))
    return
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: '未登录' }))
})
await new Promise((resolve) => workbench.listen(0, '127.0.0.1', resolve))
process.env.WORKBENCH_SSO_URL = `http://127.0.0.1:${workbench.address().port}`

const dbStore = (await import('../db.js')).default ?? (await import('../db.js'))
dbStore.upsertUser({
  id: BROADCAST_USER_ID,
  username: 'hetao',
  display_name: '贺老师',
  password_hash: 'test-hash',
  password_salt: 'test-salt',
  contact_type: 'email',
  contact_value: 'hetao@example.test',
  plan: 'yearly',
  plan_expires: new Date(Date.now() + 86400000 * 30).toISOString(),
  created_at: new Date().toISOString(),
})

const { spawn } = await import('node:child_process')
const port = await new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})
const app = spawn(process.execPath, ['server.js'], {
  cwd: join(__dirname0, '..'),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appStderr = ''
app.stderr.on('data', (d) => { appStderr += String(d) })

let up = false
for (let i = 0; i < 80 && !up; i++) {
  try { const r = await fetch(`http://127.0.0.1:${port}/api/classes`); if (r.status) up = true } catch {}
  if (!up) await new Promise((r) => setTimeout(r, 100))
}
assert.ok(up, 'server did not start: ' + appStderr.slice(0, 300))
const post = (headers) => fetch(`http://127.0.0.1:${port}/api/sso/from-workbench`, { method: 'POST', headers })

test('缺少工作台会话时拒绝', async () => {
  const r = await post({})
  assert.equal(r.status, 401)
})

test('工作台令牌无效时拒绝', async () => {
  const r = await post({ Authorization: 'Bearer nope' })
  assert.equal(r.status, 401)
  const b = await r.json()
  assert.match(b.error, /过期/)
})

test('有效工作台会话换发广播令牌并可调用 profile', async () => {
  let resp
  try {
    resp = await post({ Authorization: 'Bearer wb-token-1' })
  } catch (error) {
    throw new Error('exchange fetch failed; server stderr: ' + appStderr.slice(0, 600))
  }
  const r = resp
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.equal(body.username, 'hetao')
  assert.ok(body.token)
  assert.equal(body.plan_status.active, true)

  const profile = await fetch(`http://127.0.0.1:${port}/api/profile`, {
    headers: { 'X-Token': body.token },
  })
  assert.equal(profile.status, 200)
  const me = await profile.json()
  assert.equal(me.username, 'hetao', '广播 profile 为扁平结构')
})

test('只有工作台账号的新老师会自动获得广播身份，无需再次注册登录', async () => {
  const response = await post({ Authorization: 'Bearer wb-token-new' })
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.display_name, '新老师')
  assert.ok(body.token)

  const profile = await fetch(`http://127.0.0.1:${port}/api/profile`, {
    headers: { 'X-Token': body.token },
  })
  assert.equal(profile.status, 200)
  const me = await profile.json()
  assert.equal(me.contact_value, 'new-teacher@example.test')
})

test.after(async () => {
  app.kill()
  workbench.close()
  await new Promise((r) => setTimeout(r, 200))
  rmSync(testDir, { recursive: true, force: true })
})

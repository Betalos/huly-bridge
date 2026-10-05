// Plain-HTTP REST API for n8n (or any HTTP client). Put TLS in front of it if it is exposed.
// Every route except /health needs "Authorization: Bearer <Huly token>"; the token is the caller's
// Huly identity, so Huly itself does the authentication. Optional "X-Huly-Workspace" overrides HULY_WORKSPACE.

const http = require('node:http')
const huly = require('./huly')

const PORT = Number(process.env.PORT ?? 8080)
if (!process.env.HULY_URL) {
  console.error('HULY_URL is required (HULY_WORKSPACE is the default workspace, optional)')
  process.exit(1)
}

const routes = [
  ['GET', /^\/me$/, (c) => huly.me(c)],
  ['GET', /^\/capabilities$/, (c) => huly.capabilities(c)],
  ['GET', /^\/projects$/, (c) => huly.listProjects(c)],
  ['GET', /^\/activity\/last$/, (c) => huly.lastActivity(c)],
  ['GET', /^\/issues\/ready$/, (c, _p, q) => huly.readyIssues(c, q)],
  ['GET', /^\/issues$/, (c, _p, q) => huly.listIssues(c, q)],
  ['POST', /^\/issues$/, (c, _p, _q, b) => huly.createIssue(c, b)],
  ['GET', /^\/issues\/([A-Z0-9]+-\d+)$/, (c, [id]) => huly.getIssue(c, id)],
  ['PATCH', /^\/issues\/([A-Z0-9]+-\d+)$/, (c, [id], _q, b) => huly.updateIssue(c, id, b)],
  ['POST', /^\/issues\/([A-Z0-9]+-\d+)\/labels$/, (c, [id], _q, b) => huly.updateLabels(c, id, b)],
  ['POST', /^\/issues\/([A-Z0-9]+-\d+)\/comments$/, (c, [id], _q, b) => huly.addComment(c, id, b)]
]

const bearer = (req) => /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1]

async function readJson (req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new huly.HttpError(400, 'Body must be JSON')
  }
}

function send (res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://bridge')
    if (url.pathname === '/health') return send(res, 200, { ok: true })

    const route = routes.find(([method, re]) => method === req.method && re.test(url.pathname))
    if (!route) return send(res, 404, { error: `No route ${req.method} ${url.pathname}` })

    const token = bearer(req)
    if (!token) return send(res, 401, { error: 'Authorization: Bearer <Huly token> is required' })
    const workspace = req.headers['x-huly-workspace'] || undefined
    const started = Date.now()
    try {
      const params = route[1].exec(url.pathname).slice(1)
      const body = req.method === 'GET' ? {} : await readJson(req)
      const client = await huly.getClient(token, workspace)
      send(res, 200, await route[2](client, params, Object.fromEntries(url.searchParams), body))
    } catch (err) {
      const status = err.status ?? 502
      if (status >= 500 && token) huly.resetClient(token, workspace)
      send(res, status, { error: err.message })
    } finally {
      console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`)
    }
  })
  .listen(PORT, () => console.log(`huly-bridge listening on :${PORT}`))

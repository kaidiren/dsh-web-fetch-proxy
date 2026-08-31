// lib/proxy.js — 零依赖的 SOCKS5 / HTTP-CONNECT 隧道抓取（复刻 dsh-net-tools 思路并补 SOCKS5）。
import { connect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export const MAX_REDIRECTS = 5
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 30000

/** 解析代理 URL，返回 { protocol, host, port }；支持 socks5/socks5h/http/https。 */
export function parseProxy(raw) {
  if (!raw) return null
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
  const protocol = url.protocol.replace(':', '')
  if (!['socks5', 'socks5h', 'http', 'https'].includes(protocol)) {
    throw new Error(`unsupported proxy protocol ${url.protocol}`)
  }
  return {
    protocol,
    host: url.hostname,
    port: Number(url.port) || (protocol === 'https' ? 443 : 1080),
  }
}

/** SOCKS5 握手 + CONNECT，返回已连到目标的隧道 socket。 */
function socks5Tunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socks5: timeout')) }, timeoutMs)
    let stage = 'greet'
    let settled = false
    const fail = (m) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeAllListeners(); socket.destroy(); reject(new Error(m)) }
    socket.on('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    socket.on('data', function onData(chunk) {
      try {
        if (stage === 'greet') {
          if (chunk[1] !== 0x00) return fail('socks5: auth not accepted, code=' + chunk[1])
          const h = Buffer.from(host, 'utf8')
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ])
          socket.write(req)
          stage = 'connect'
        } else {
          if (chunk[1] !== 0x00) return fail('socks5: connect failed code=' + chunk[1])
          if (settled) return
          settled = true
          clearTimeout(timer)
          socket.removeListener('data', onData)
          resolve(socket)
        }
      } catch (e) { fail('socks5: ' + e.message) }
    })
    socket.on('error', (e) => fail('socks5: ' + e.message))
  })
}

/** HTTP/CONNECT 隧道。 */
function httpTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('http-tunnel: timeout')) }, timeoutMs)
    let settled = false
    const fail = (m) => { if (settled) return; settled = true; clearTimeout(timer); socket.removeAllListeners(); socket.destroy(); reject(new Error(m)) }
    socket.on('connect', () => socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`))
    let buf = ''
    socket.on('data', function onData(chunk) {
      buf += chunk.toString('latin1')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) return
      const statusLine = buf.slice(0, buf.indexOf('\r\n'))
      if (!/ 200 /.test(statusLine)) return fail('http-tunnel: ' + statusLine)
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      const leftover = Buffer.from(buf.slice(idx + 4), 'latin1')
      if (leftover.length) socket.unshift(leftover)
      resolve(socket)
    })
    socket.on('error', (e) => fail('http-tunnel: ' + e.message))
  })
}

/** 建立到 target host:port 的隧道 socket。 */
export async function openTunnel(proxy, host, port, timeoutMs) {
  if (proxy.protocol === 'socks5' || proxy.protocol === 'socks5h') return socks5Tunnel(proxy, host, port, timeoutMs)
  return httpTunnel(proxy, host, port, timeoutMs)
}

/** 通过已建立的隧道做一次 HTTP(S) 请求，返回 { status, headers, body, truncated }。 */
export function requestThroughTunnel(socket, target, { method = 'GET', headers = {} } = {}, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const isHttps = target.protocol === 'https:'
    let settled = false
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`request: timeout after ${timeoutMs}ms`)) }, timeoutMs)
    const settle = (status, respHeaders, body, truncated) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ status, headers: respHeaders, body, truncated }) }
    const fail = (m) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); reject(new Error(m)) }

    let buffer = Buffer.alloc(0)
    let seen = false // 是否已看到响应头
    let status = 0
    let respHeaders = {}
    let chunks = []
    let total = 0
    let truncated = false

    const pushBody = (data) => {
      chunks.push(data)
      total += data.length
      if (total >= maxBytes) {
        truncated = true
        socket.removeListener('data', onData)
        socket.destroy()
        settle(status, respHeaders, Buffer.concat(chunks).subarray(0, maxBytes), true)
      }
    }

    const onData = (chunk) => {
      if (!seen) {
        buffer = Buffer.concat([buffer, chunk])
        const idx = buffer.indexOf('\r\n\r\n')
        if (idx === -1) return
        const rawHead = buffer.slice(0, idx).toString('latin1')
        const lines = rawHead.split('\r\n')
        const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(lines[0])
        if (!m) return fail('bad status line: ' + lines[0])
        status = Number(m[1])
        const h = {}
        for (let i = 1; i < lines.length; i++) {
          const c = lines[i].indexOf(':')
          if (c > 0) h[lines[i].slice(0, c).toLowerCase()] = lines[i].slice(c + 1).trim()
        }
        respHeaders = h
        seen = true
        const bodyStart = idx + 4
        if (bodyStart < buffer.length) pushBody(buffer.slice(bodyStart))
        buffer = Buffer.alloc(0)
      } else {
        pushBody(chunk)
      }
    }

    const writeOver = (stream) => {
      const requestTarget = target.pathname + target.search
      const hdrs = {
        Host: target.host,
        'User-Agent': 'dsh-web-fetch-proxy/0.1',
        Accept: 'text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        Connection: 'close',
        ...headers,
      }
      const headStr = Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join('\r\n')
      stream.on('data', onData)
      stream.on('end', () => { if (settled) return; if (seen) { settled = true; clearTimeout(timer); resolve({ status, headers: respHeaders, body: Buffer.concat(chunks), truncated }) } })
      stream.on('error', (e) => fail('stream: ' + e.message))
      stream.write(`${method} ${requestTarget} HTTP/1.1\r\n${headStr}\r\n\r\n`)
    }

    if (isHttps) {
      const tlsSock = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] }, () => writeOver(tlsSock))
      tlsSock.on('error', (e) => fail('tls: ' + e.message))
    } else {
      writeOver(socket)
    }
  })
}

/** 走代理抓取一个 URL（带重定向、大小、超时）。返回 { statusCode, headers, body, finalUrl, truncated }。 */
export async function proxiedFetch(rawUrl, proxy, opts = {}) {
  const p = typeof proxy === 'string' ? parseProxy(proxy) : proxy
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let current = new URL(rawUrl)
  let redirects = 0
  for (;;) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('only http/https supported')
    const tunnel = await openTunnel(p, current.hostname, Number(current.port) || (current.protocol === 'https:' ? 443 : 80), timeoutMs)
    try {
      const result = await requestThroughTunnel(tunnel, current, { method: 'GET' }, { timeoutMs, maxBytes })
      tunnel.destroy()
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const loc = (result.headers['location'] || '').trim()
        if (!loc) throw new Error('redirect without location (HTTP ' + result.status + ')')
        if (redirects >= MAX_REDIRECTS) throw new Error('too many redirects')
        current = new URL(loc, current)
        redirects++
        continue
      }
      return {
        statusCode: result.status,
        headers: result.headers,
        body: result.body,
        finalUrl: current.toString(),
        truncated: result.truncated,
      }
    } finally {
      tunnel.destroy()
    }
  }
}

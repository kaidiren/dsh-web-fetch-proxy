// dsh-web-fetch-proxy — 把 net_fetch 的"走代理抓取"逻辑做成 web_fetch 的 fetch provider。
// 注册到 ctx.web，让 web_fetch 工具通过配置的 SOCKS5/HTTP 代理抓取（绕开本地 fake-ip）。
import { proxiedFetch, parseProxy } from './proxy.js'

export const name = 'dsh-web-fetch-proxy'
export const inject = ['web']

const DEFAULT_PROXY =
  process.env.DSH_NET_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || 'socks5://127.0.0.1:1086'

function classifyContentType(contentType) {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return 'text'
}

export function apply(ctx, config = {}) {
  const proxyUrl = config.proxy || DEFAULT_PROXY
  const maxBytes = config.maxBytes ?? 5 * 1024 * 1024
  const maxBodyChars = config.maxBodyChars ?? 200000
  const timeoutMs = config.timeoutMs ?? 30000

  const provider = {
    id: 'proxy',
    available: () => true,
    async fetch(request, signal) {
      const r = await proxiedFetch(request.url, parseProxy(proxyUrl), { maxBytes, timeoutMs })
      const kind = classifyContentType(r.headers['content-type'])
      const decoded = r.body.toString('utf8')
      const truncatedByChars = decoded.length > maxBodyChars
      const content = truncatedByChars ? decoded.slice(0, maxBodyChars) : decoded
      return {
        url: r.finalUrl,
        statusCode: r.statusCode,
        body: kind === 'html' ? { kind: 'html', content } : { kind: 'text', content },
        truncated: r.truncated || truncatedByChars,
      }
    },
  }

  const dispose = ctx.web.registerFetchProvider(provider)
  ctx.effect(() => dispose)
  ctx.logger?.info?.('[dsh-web-fetch-proxy] registered web_fetch provider (proxy) ' + proxyUrl)
}

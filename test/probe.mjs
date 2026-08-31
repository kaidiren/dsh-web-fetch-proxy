import { proxiedFetch } from '../lib/proxy.js'

const proxy = process.env.PROXY || 'socks5://127.0.0.1:1086'
const url = process.argv[2] || 'https://www.google.com/'
try {
  const r = await proxiedFetch(url, proxy, { timeoutMs: 12000, maxBytes: 512000 })
  console.log('status', r.statusCode, '| bytes', r.body.length, '| finalUrl', r.finalUrl, '| truncated', r.truncated)
  console.log('first120:', r.body.toString('utf8').slice(0, 120).replace(/\s+/g, ' '))
} catch (e) {
  console.error('FAIL:', e.message)
  process.exit(1)
}

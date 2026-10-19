// lib/extract.js — 用 Mozilla Readability + linkedom 从整页 HTML 抽取正文片段。
//
// 目标：让 web_fetch 拿到"抽取后的正文"，而不是整页 1.7MB 原始 HTML 被
// dsh-tool-web 的 200k 字符上限从 head 的内联 CSS 里腰斩。抽取失败时返回
// null，由调用方回退到原来的"直抓 + 字符截断"逻辑，保证不比现状差。

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/** 判为"抽到了真正文"的最短字符数；低于它视为抽取失败。 */
const MIN_ARTICLE_CHARS = 300

/** 正文 HTML 的硬上限，防止极端页面把 turndown 拖死。 */
const MAX_CONTENT_CHARS = 1_000_000

/** 去掉 <head> 与注释，用于抽取失败时的回退路径（至少不让内联 CSS 吃掉配额）。 */
export function stripHead(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<head\b[\s\S]*?<\/head>/gi, '')
    .replace(/<!doctype[^>]*>/gi, '')
}

/** 把标题里的 HTML 特殊字符转义，避免注入。 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 给页面注入 <base>，让 Readability 把相对链接与图片地址转成绝对 URL。 */
function withBaseHref(html, url) {
  if (!url) return html
  const base = `<base href="${escapeHtml(url)}">`
  const withoutBase = html.replace(/<base\b[^>]*>/gi, '')
  return withoutBase.replace(/<head\b[^>]*>/i, (match) => `${match}${base}`)
}

/**
 * 从整页 HTML 抽取正文。
 *
 * @param {string} html 原始 HTML
 * @param {string} [url] 页面最终 URL，用于把相对链接转绝对
 * @returns {{ title: string, content: string, truncated: boolean } | null}
 *   抽取成功返回干净 HTML 片段；失败或正文过短返回 null。
 */
export function extractArticle(html, url) {
  if (typeof html !== 'string' || html.length === 0) return null

  let document
  try {
    ;({ document } = parseHTML(withBaseHref(html, url)))
  } catch {
    return null
  }

  // linkedom 对空串/纯空白/纯文本/仅注释/仅 doctype 的输入会产出
  // documentElement 为 null 的文档；此时 Readability 无正文可抽，且
  // document.title 的 getter 会解构 documentElement.firstElementChild 抛错。
  // 直接放弃抽取，由调用方回退到 raw body 路径。
  if (document.documentElement === null) return null

  let pageTitle = ''
  try {
    pageTitle = (document.title || '').trim()
  } catch {
    // 标题读取失败不影响正文抽取，按无标题处理。
  }

  let article
  try {
    article = new Readability(document, { charThreshold: MIN_ARTICLE_CHARS }).parse()
  } catch {
    return null
  }
  if (!article || typeof article.content !== 'string') return null

  let content = article.content.trim()
  if (content.length < MIN_ARTICLE_CHARS) return null

  const truncated = content.length > MAX_CONTENT_CHARS
  if (truncated) content = content.slice(0, MAX_CONTENT_CHARS)

  const title = (article.title || pageTitle || '').trim()
  if (title && !content.includes(title)) {
    content = `<h1>${escapeHtml(title)}</h1>\n${content}`
  }

  return { title, content, truncated }
}

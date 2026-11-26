/**
 * RSS 2.0 for the blog, with the full article body in `content:encoded`.
 *
 * Inline HTML inside blocks was sanitized on write (see `blocks.ts`), so it is
 * emitted as is. Plain-text fields (code, URLs, titles) are escaped here.
 */
import type { EditorBlock, EditorDocument } from "./blocks.ts";

export const SITE_URL = "https://corbin.dev";
export const FEED_URL = `${SITE_URL}/rss.xml`;

export interface FeedArticle {
  id: string;
  title: string;
  date: string;
  uri: string;
  excerpt: string;
  content?: EditorDocument;
  banner?: { url: string; alt?: string };
  category?: string;
  tags?: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** `mediaBase` is the origin that site-relative image paths resolve against. */
export function buildFeed(articles: FeedArticle[], mediaBase: string): string {
  const updated = articles.reduce(
    (latest, article) => Math.max(latest, article.updatedAt.getTime()),
    0,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    "<channel>",
    "<title>Corbin.dev Blog</title>",
    `<link>${SITE_URL}/blog</link>`,
    "<description>News and articles on software engineering, gaming, technologies, cats, coffee, and more.</description>",
    "<language>en</language>",
    `<atom:link href="${FEED_URL}" rel="self" type="application/rss+xml"/>`,
    // Taken from the articles, not the clock, so an unchanged feed stays identical.
    ...(updated ? [`<lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>`] : []),
    ...articles.map((article) => item(article, mediaBase)),
    "</channel>",
    "</rss>",
    "",
  ].join("\n");
}

function item(article: FeedArticle, mediaBase: string): string {
  const link = `${SITE_URL}/blog/a/${encodeURIComponent(article.date)}/${encodeURIComponent(article.uri)}`;
  const banner = article.banner?.url
    ? image(article.banner.url, article.banner.alt ?? "", mediaBase)
    : "";
  const body =
    banner + (article.content?.blocks ?? []).map((b) => renderBlock(b, mediaBase)).join("");
  const categories = new Set(
    [article.category, ...(article.tags ?? [])].filter(Boolean) as string[],
  );

  return [
    "<item>",
    `<title>${escapeXml(article.title)}</title>`,
    `<link>${escapeXml(link)}</link>`,
    // Keyed on the id, so moving an article's URL does not re-deliver it to readers.
    `<guid isPermaLink="false">urn:corbin.dev:article:${escapeXml(article.id)}</guid>`,
    `<pubDate>${article.createdAt.toUTCString()}</pubDate>`,
    "<dc:creator>Emrys Corbin</dc:creator>",
    ...[...categories].map((c) => `<category>${escapeXml(c)}</category>`),
    `<description>${escapeXml(article.excerpt)}</description>`,
    `<content:encoded>${cdata(absoluteLinks(body, link))}</content:encoded>`,
    "</item>",
  ].join("\n");
}

function renderBlock(block: EditorBlock, mediaBase: string): string {
  const data = block.data as Record<string, any>;

  switch (block.type) {
    case "paragraph":
      return `<p>${data.text ?? ""}</p>`;
    case "header": {
      const level = [2, 3, 4, 5, 6].includes(data.level) ? data.level : 2;
      return `<h${level}>${data.text ?? ""}</h${level}>`;
    }
    case "list":
      return list(data.items, data.style === "ordered" ? "ol" : "ul");
    case "image": {
      if (!data.file?.url) return "";
      const alt = String(data.caption ?? "").replace(/<[^>]*>/g, "").trim();
      const caption = data.caption ? `<figcaption>${data.caption}</figcaption>` : "";
      return `<figure>${image(data.file.url, alt, mediaBase)}${caption}</figure>`;
    }
    case "code":
      return `<pre><code>${escapeXml(String(data.code ?? ""))}</code></pre>`;
    case "quote": {
      const cite = data.caption ? `<cite>${data.caption}</cite>` : "";
      return `<blockquote><p>${data.text ?? ""}</p>${cite}</blockquote>`;
    }
    case "delimiter":
      return "<hr>";
    case "table": {
      const rows: string[][] = data.content ?? [];
      const tr = (row: string[], cell: "th" | "td") =>
        `<tr>${row.map((value) => `<${cell}>${value}</${cell}>`).join("")}</tr>`;
      const body = rows.map((row, i) => tr(row, data.withHeadings && i === 0 ? "th" : "td"));
      return `<table>${body.join("")}</table>`;
    }
    default:
      return "";
  }
}

function list(items: unknown, tag: "ol" | "ul"): string {
  if (!Array.isArray(items) || items.length === 0) return "";
  const entries = items.map((item) =>
    typeof item === "string"
      ? `<li>${item}</li>`
      : `<li>${item?.content ?? ""}${list(item?.items, tag)}</li>`,
  );
  return `<${tag}>${entries.join("")}</${tag}>`;
}

function image(url: string, alt: string, mediaBase: string): string {
  return `<img src="${escapeXml(resolve(url, mediaBase))}" alt="${escapeXml(alt)}">`;
}

/** A reader shows the body away from the site, so relative links need an origin. */
function absoluteLinks(html: string, base: string): string {
  return html.replace(
    /(<a\b[^>]*?\shref=")([^"]*)"/g,
    (_, start, href) => `${start}${resolve(href, base)}"`,
  );
}

function resolve(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/** Drops the control characters XML 1.0 forbids, which would break the whole feed. */
function clean(value: string): string {
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, "");
}

function escapeXml(value: string): string {
  return clean(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** `]]>` would end the section early, so it is split across two. */
function cdata(value: string): string {
  return `<![CDATA[${clean(value).replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

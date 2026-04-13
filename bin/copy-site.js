#!/usr/bin/env node

const { URL } = require("url");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const url = process.argv[2];
if (!url) {
  console.error("Usage: copy-site <url>");
  process.exit(1);
}

const baseUrl = new URL(url);
const baseName = baseUrl.hostname.replace(/\./g, "_") + (baseUrl.pathname !== "/" ? "_" + baseUrl.pathname.replace(/\//g, "_").replace(/^_|_$/g, "") : "");
const sitesDir = path.resolve(process.cwd(), "sites");
fs.mkdirSync(sitesDir, { recursive: true });

// Find available name: name, name_2, name_3, ...
let siteName = baseName;
let copyNum = 1;
while (fs.existsSync(path.join(sitesDir, siteName))) {
  copyNum++;
  siteName = `${baseName}_${copyNum}`;
}

const outDir = path.join(sitesDir, siteName);
const distDir = path.join(outDir, "dist");

function fetch(targetUrl) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const client = parsedUrl.protocol === "https:" ? https : http;

    const doRequest = (reqUrl, redirects = 0) => {
      if (redirects > 10) return reject(new Error(`Too many redirects: ${targetUrl}`));
      const parsed = new URL(reqUrl);
      const c = parsed.protocol === "https:" ? https : http;

      c.get(reqUrl, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, reqUrl).href;
          res.resume();
          return doRequest(redirectUrl, redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${reqUrl}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    };

    doRequest(targetUrl);
  });
}

function resolveUrl(resourceUrl) {
  if (!resourceUrl || resourceUrl.startsWith("data:") || resourceUrl.startsWith("javascript:") || resourceUrl.startsWith("#")) {
    return null;
  }
  try {
    if (resourceUrl.startsWith("//")) {
      return new URL(`${baseUrl.protocol}${resourceUrl}`).href;
    }
    return new URL(resourceUrl, url).href;
  } catch {
    return null;
  }
}

function resourcePath(resourceUrl) {
  try {
    const crypto = require("crypto");
    const parsed = new URL(resourceUrl);
    let p = parsed.pathname.replace(/^\//, "");
    if (!p || p.endsWith("/")) p += "index.html";

    // Use a short hash of the full URL to avoid path collisions
    const hash = crypto.createHash("md5").update(resourceUrl).digest("hex").slice(0, 8);

    // Get extension from the URL, guessing from the last segment that looks like a file
    const segments = p.split("/").filter(Boolean);
    let ext = "";
    let base = "file";
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].split("?")[0];
      const e = path.extname(seg);
      if (e) {
        ext = e;
        base = path.basename(seg, e);
        break;
      }
    }
    if (!ext) {
      base = segments[segments.length - 1] || "file";
    }

    const subDir = parsed.hostname !== baseUrl.hostname ? parsed.hostname : "";
    return path.join(subDir, `${base}_${hash}${ext}`);
  } catch {
    return null;
  }
}

function extractCssUrls(cssText, cssUrl) {
  const urls = [];
  const regex = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let match;
  while ((match = regex.exec(cssText)) !== null) {
    const raw = match[1].trim();
    if (raw.startsWith("data:")) continue;
    try {
      const abs = new URL(raw, cssUrl).href;
      urls.push({ raw, abs });
    } catch {}
  }
  return urls;
}

async function main() {
  console.log(`Downloading: ${url}`);

  // 1. Fetch HTML
  const htmlBuf = await fetch(url);
  let html = htmlBuf.toString("utf-8");
  const $ = cheerio.load(html);

  // 2. Collect resource URLs
  const resources = new Map(); // absoluteUrl -> localPath

  // Normalize the page URL for comparison
  const pageUrlNorm = new URL(url).href.replace(/\/$/, "");

  function addResource(absUrl) {
    if (!absUrl || resources.has(absUrl)) return;
    // Skip if the resource URL is the page itself
    const norm = absUrl.replace(/\/$/, "");
    if (norm === pageUrlNorm) return;
    const localPath = resourcePath(absUrl);
    if (localPath) resources.set(absUrl, localPath);
  }

  // link[href] — stylesheets, icons, manifests (skip canonical)
  $("link[href]").each((_, el) => {
    const rel = ($(el).attr("rel") || "").toLowerCase();
    if (rel === "canonical") return;
    const href = $(el).attr("href");
    addResource(resolveUrl(href));
  });

  // script[src]
  $("script[src]").each((_, el) => {
    const src = $(el).attr("src");
    addResource(resolveUrl(src));
  });

  // img[src], img[srcset]
  $("img[src]").each((_, el) => {
    addResource(resolveUrl($(el).attr("src")));
  });
  $("img[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    srcset.split(",").forEach((entry) => {
      const u = entry.trim().split(/\s+/)[0];
      addResource(resolveUrl(u));
    });
  });

  // source[src], source[srcset]
  $("source[src]").each((_, el) => addResource(resolveUrl($(el).attr("src"))));
  $("source[srcset]").each((_, el) => {
    $(el).attr("srcset").split(",").forEach((entry) => {
      addResource(resolveUrl(entry.trim().split(/\s+/)[0]));
    });
  });

  // video[src], audio[src], video[poster]
  $("video[src], audio[src]").each((_, el) => addResource(resolveUrl($(el).attr("src"))));
  $("video[poster]").each((_, el) => addResource(resolveUrl($(el).attr("poster"))));

  // meta og:image, twitter:image
  $('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    addResource(resolveUrl($(el).attr("content")));
  });

  // Inline style background-image urls
  $("[style]").each((_, el) => {
    const style = $(el).attr("style");
    const cssUrls = extractCssUrls(style, url);
    cssUrls.forEach(({ abs }) => addResource(abs));
  });

  console.log(`Found ${resources.size} resources`);

  // 3. Download all resources
  fs.mkdirSync(distDir, { recursive: true });

  const downloaded = new Map(); // absUrl -> localPath (confirmed)
  const cssFiles = []; // { absUrl, localPath, content }

  const concurrency = 10;
  const entries = [...resources.entries()];

  for (let i = 0; i < entries.length; i += concurrency) {
    const batch = entries.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(async ([absUrl, localPath]) => {
        const data = await fetch(absUrl);
        const fullPath = path.join(distDir, localPath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, data);
        downloaded.set(absUrl, localPath);

        if (localPath.endsWith(".css")) {
          cssFiles.push({ absUrl, localPath, content: data.toString("utf-8") });
        }

        console.log(`  ✓ ${localPath}`);
        return localPath;
      })
    );

    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        console.error(`  ✗ ${batch[idx][1]} — ${r.reason.message}`);
      }
    });
  }

  // 4. Process CSS files — find and download nested resources (fonts, images)
  const cssNested = new Map();
  for (const { absUrl: cssAbsUrl, localPath: cssLocalPath, content } of cssFiles) {
    const nested = extractCssUrls(content, cssAbsUrl);
    for (const { abs } of nested) {
      if (!downloaded.has(abs) && !cssNested.has(abs)) {
        const lp = resourcePath(abs);
        if (lp) cssNested.set(abs, lp);
      }
    }
  }

  if (cssNested.size > 0) {
    console.log(`Found ${cssNested.size} nested CSS resources (fonts, images)`);
    const nestedEntries = [...cssNested.entries()];
    for (let i = 0; i < nestedEntries.length; i += concurrency) {
      const batch = nestedEntries.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async ([absUrl, localPath]) => {
          const data = await fetch(absUrl);
          const fullPath = path.join(distDir, localPath);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, data);
          downloaded.set(absUrl, localPath);
          console.log(`  ✓ ${localPath}`);
        })
      );
      results.forEach((r, idx) => {
        if (r.status === "rejected") {
          console.error(`  ✗ ${batch[idx][1]} — ${r.reason.message}`);
        }
      });
    }
  }

  // 5. Rewrite CSS url() paths to local
  for (const { absUrl: cssAbsUrl, localPath: cssLocalPath, content } of cssFiles) {
    let newCss = content;
    const nested = extractCssUrls(content, cssAbsUrl);
    for (const { raw, abs } of nested) {
      const lp = downloaded.get(abs);
      if (lp) {
        const from = path.dirname(cssLocalPath);
        const rel = path.relative(from, lp).replace(/\\/g, "/");
        newCss = newCss.split(raw).join(rel);
      }
    }
    const fullPath = path.join(distDir, cssLocalPath);
    fs.writeFileSync(fullPath, newCss);
  }

  // 6. Rewrite HTML paths using cheerio for precision
  const $out = cheerio.load(htmlBuf.toString("utf-8"));

  // Build lookup: original URL variants -> dist path
  const urlMap = new Map(); // variant -> distPath
  for (const [absUrl, localPath] of downloaded) {
    const distPath = `dist/${localPath}`;
    const parsed = new URL(absUrl);
    urlMap.set(absUrl, distPath);
    urlMap.set(`//${parsed.host}${parsed.pathname}`, distPath);
    if (parsed.hostname === baseUrl.hostname) {
      urlMap.set(parsed.pathname, distPath);
    }
  }

  function rewriteAttr(selector, attr) {
    $out(selector).each((_, el) => {
      const val = $out(el).attr(attr);
      if (!val) return;
      const resolved = resolveUrl(val);
      if (resolved && downloaded.has(resolved)) {
        $out(el).attr(attr, `dist/${downloaded.get(resolved)}`);
      } else if (urlMap.has(val)) {
        $out(el).attr(attr, urlMap.get(val));
      }
    });
  }

  // Rewrite resource attributes (skip canonical, og:url, twitter:url)
  rewriteAttr('link[href]:not([rel="canonical"])', "href");
  rewriteAttr("script[src]", "src");
  rewriteAttr("img[src]", "src");
  rewriteAttr("video[src]", "src");
  rewriteAttr("audio[src]", "src");
  rewriteAttr("video[poster]", "poster");
  rewriteAttr("source[src]", "src");

  // Rewrite srcset
  $out("img[srcset], source[srcset]").each((_, el) => {
    const srcset = $out(el).attr("srcset");
    if (!srcset) return;
    const newSrcset = srcset.split(",").map((entry) => {
      const parts = entry.trim().split(/\s+/);
      const resolved = resolveUrl(parts[0]);
      if (resolved && downloaded.has(resolved)) {
        parts[0] = `dist/${downloaded.get(resolved)}`;
      }
      return parts.join(" ");
    }).join(", ");
    $out(el).attr("srcset", newSrcset);
  });

  // Rewrite meta og:image, twitter:image
  $out('meta[property="og:image"], meta[name="twitter:image"]').each((_, el) => {
    const val = $out(el).attr("content");
    const resolved = resolveUrl(val);
    if (resolved && downloaded.has(resolved)) {
      $out(el).attr("content", `dist/${downloaded.get(resolved)}`);
    }
  });

  // Rewrite inline style url()s
  $out("[style]").each((_, el) => {
    let style = $out(el).attr("style");
    const cssUrls = extractCssUrls(style, url);
    for (const { raw, abs } of cssUrls) {
      if (downloaded.has(abs)) {
        style = style.split(raw).join(`dist/${downloaded.get(abs)}`);
      }
    }
    $out(el).attr("style", style);
  });

  // 7. Write index.html
  fs.writeFileSync(path.join(outDir, "index.html"), $out.html());

  console.log(`\nDone! Site saved to: ${outDir}`);
  console.log(`  index.html + ${downloaded.size} resources in dist/`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

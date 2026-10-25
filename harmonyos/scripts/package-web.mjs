import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundle the classic-script frontend into one offline ArkWeb rawfile.
// Runtime AI requests are optional; no CDN or web server is needed to open the app.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.argv[2] || path.join(project, '..', 'web'));
const output = path.resolve(process.argv[3] || path.join(project, 'entry/src/main/resources/rawfile/index.html'));
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];
const localFile = (url, base = source) => {
  if (/^(?:[a-z]+:|\/\/)/i.test(url)) throw new Error(`External asset cannot be packaged offline: ${url}`);
  const clean = decodeURIComponent(url.split(/[?#]/)[0]);
  const full = path.resolve(base, clean.startsWith('/') ? '.' + clean : clean);
  const relative = path.relative(source, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Asset escapes web source: ${url}`);
  return full;
};
const mime = {'.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff2':'font/woff2'};
const asset = (url, base) => {
  if (/^(?:data:|#)/i.test(url)) return url;
  const full = localFile(url, base);
  return `data:${mime[path.extname(full)] || 'application/octet-stream'};base64,${fs.readFileSync(full).toString('base64')}`;
};
const cssInline = (css, base) => {
  if (/@import\b/i.test(css)) throw new Error('CSS @import must be bundled first.');
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/g, (_, q, url) => `url("${asset(url, base)}")`);
};
let html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
const scripts = [];
html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, tag => {
  const type = attr(tag, 'type');
  if (type === 'module') throw new Error('Bundle ES modules into classic scripts before packaging.');
  if (type && !/^(?:text|application)\/javascript$/i.test(type)) return tag;
  const src = attr(tag, 'src');
  const js = src ? fs.readFileSync(localFile(src), 'utf8') : tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script\s*>$/i, '');
  scripts.push(js.replace(/^\/\/[#@] sourceMappingURL=.*$/gm, '').replace(/<\/script/gi, '<\\/script'));
  return '';
});
html = html.replace(/<link\b[^>]*>/gi, tag => {
  const rel = attr(tag, 'rel') || '';
  const href = attr(tag, 'href');
  if (/manifest|preload|modulepreload/i.test(rel)) return '';
  if (/stylesheet/i.test(rel) && href) {
    const file = localFile(href);
    return `<style>${cssInline(fs.readFileSync(file, 'utf8'), path.dirname(file)).replace(/<\/style/gi, '<\\/style')}</style>`;
  }
  if (/icon/i.test(rel) && href) return tag.replace(href, asset(href, source));
  return tag;
});
html = html.replace(/<(?:img|source)\b[^>]*>/gi, tag => {
  const src = attr(tag, 'src');
  return src ? tag.replace(src, asset(src, source)) : tag;
});
if (!/<\/body>/i.test(html)) throw new Error('web/index.html needs a closing body.');
if (!scripts.length) throw new Error('No classic scripts found in web/index.html.');
html = html.replace(/<\/body>/i, () => `<script>window.HYS_NATIVE=true;window.HYS_DISABLE_SW=true;</script>\n${scripts.map(js => `<script>\n${js}\n</script>`).join('\n')}\n</body>`);
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, html, 'utf8');
console.log(`Embedded ${scripts.length} ordered scripts; ${Buffer.byteLength(html)} bytes -> ${output}`);

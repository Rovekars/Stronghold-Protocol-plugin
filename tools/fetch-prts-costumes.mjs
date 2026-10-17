#!/usr/bin/env node
// tools/fetch-prts-costumes.mjs — 构建期抓取 PRTS 时装回廊数据
//
// 输出 data/costumes.json，供 operator-skin 插件使用。
// 抓取策略：
//   1. GET /w/时装回廊（带桌面浏览器头）拿到系列卡片列表；
//   2. 从每个系列卡片提取系列名与所有皮肤名；
//   3. GET 每个系列子页 /w/时装回廊/<系列>，解析出实际存在的半身像/立绘/头像 URL；
//   4. 按"干员名 + skinN"聚合图片，并用卡片顺序把皮肤名挂上。
//
// PRTS 无 CORS 头，因此必须在构建期抓取；图像 URL 直接给浏览器 <img> 热链即可。
//
// Usage: node tools/fetch-prts-costumes.mjs [--offline] [--cache-dir <dir>] [--out <file>]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'costumes.json');
const CACHE_DIR = join(ROOT, '.cache', 'prts-costumes');
const MAIN_URL = 'https://prts.wiki/w/%E6%97%B6%E8%A3%85%E5%9B%9E%E5%BB%8A';
const SERIES_BASE = 'https://prts.wiki/w/%E6%97%B6%E8%A3%85%E5%9B%9E%E5%BB%8A/';

const HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'Cache-Control': 'max-age=0',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

function parseArgs(argv) {
  const opts = { offline: false, out: OUT, cacheDir: CACHE_DIR };
  const flags = { '--offline': 'offline' };
  const dirs = { '--out': 'out', '--cache-dir': 'cacheDir' };
  for (let i = 0; i < argv.length; i++) {
    const [name, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], null];
    if (name === '--help' || name === '-h') { console.log('usage: node tools/fetch-prts-costumes.mjs [--offline] [--cache-dir <dir>] [--out <file>]'); process.exit(0); }
    if (flags[name] && inline === null) { opts[flags[name]] = true; continue; }
    if (dirs[name]) {
      const v = inline ?? argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${name} needs a path argument`);
      opts[dirs[name]] = resolve(v);
      continue;
    }
    throw new Error(`unknown option ${argv[i]}`);
  }
  return opts;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#58;/g, ':')
    .replace(/&#61;/g, '=')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeMediaUrl(url) {
  // 去掉 ?v= 缓存戳；去掉 thumb/... 缩放路径，还原原始文件路径
  try {
    const u = new URL(url);
    u.search = '';
    let pathname = decodeURIComponent(u.pathname);
    // /thumb/a/ab/文件名.png/120px-文件名.png -> /a/ab/文件名.png
    const thumbMatch = pathname.match(/^\/thumb(\/[0-9a-f]\/[0-9a-f]{2}\/[^/]+)\/[0-9]+px-[^/]+$/);
    if (thumbMatch) pathname = thumbMatch[1];
    u.pathname = pathname;
    return u.toString();
  } catch {
    return url.replace(/\?v=[^?&]*/, '');
  }
}

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchText(url, cachePath, { offline } = {}) {
  if (existsSync(cachePath) && offline) return decodeHtmlEntities(await readFile(cachePath, 'utf8'));
  if (existsSync(cachePath)) {
    // 有缓存时直接复用，避免反复请求 PRTS
    return decodeHtmlEntities(await readFile(cachePath, 'utf8'));
  }
  const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  if (text.includes('<title>403 Forbidden</title>')) throw new Error(`fetch ${url} blocked (403)`);
  await writeFile(cachePath, text, 'utf8');
  await sleep(500);
  return decodeHtmlEntities(text);
}

function parseMainPage(html) {
  // 主页面每个皮肤独立一个 charskinbtn-container，系列名在 href 路径里
  const cardRe = /<div class="charskinbtn-container"><div class="skinwrapper charskinbtn-controler">([\s\S]*?)<\/div><\/div>/g;
  const bySeries = new Map();
  let card;
  while ((card = cardRe.exec(html)) !== null) {
    const c = card[1];
    const hrefMatch = c.match(/href="\/w\/([^"]+)"/);
    const skinNameMatch = c.match(/class="charnameEn">([^<]+)<\/div>/);
    const brandEnMatch = c.match(/class="skinname">([^<]+)<\/div>/);
    const tagMatch = c.match(/class="skintag">([^<]*)<\/div>/);
    if (!hrefMatch || !skinNameMatch) continue;
    const [seriesPathEncoded, skinNameEncoded] = hrefMatch[1].split('#');
    const seriesPath = decodeURIComponent(seriesPathEncoded);
    const seriesName = seriesPath.replace('时装回廊/', '');
    if (!bySeries.has(seriesPath)) {
      bySeries.set(seriesPath, {
        path: seriesPath,
        name: seriesName,
        brandEn: brandEnMatch ? brandEnMatch[1].trim() : '',
        cards: [],
      });
    }
    bySeries.get(seriesPath).cards.push({
      seriesPath,
      seriesName,
      skinName: decodeURIComponent(skinNameEncoded || ''),
      brandEn: brandEnMatch ? brandEnMatch[1].trim() : '',
      tag: tagMatch ? tagMatch[1].trim() : '',
    });
  }
  return Array.from(bySeries.values());
}

function parseSeriesPage(html) {
  // 1. 顶部卡片列表（顺序与主页面一致，有皮肤名和品牌）
  const cardRe = /<div class="skinwrapper charskinbtn-controler">([\s\S]*?)<\/div>\s*<\/div>/g;
  const cards = [];
  let card;
  while ((card = cardRe.exec(html)) !== null) {
    const c = card[1];
    const skinNameMatch = c.match(/class="charnameEn">([^<]+)<\/div>/);
    const brandEnMatch = c.match(/class="skinname">([^<]+)<\/div>/);
    if (!skinNameMatch) continue;
    cards.push({
      skinName: skinNameMatch[1].trim(),
      brandEn: brandEnMatch ? brandEnMatch[1].trim() : '',
    });
  }

  // 2. 所有实际存在的媒体 URL，按文件名解析类型/干员/skinN
  const urlRe = /https:\/\/media\.prts\.wiki\/[^"'\s<>]+/g;
  const seen = new Set();
  const images = [];
  let urlMatch;
  while ((urlMatch = urlRe.exec(html)) !== null) {
    const raw = urlMatch[0];
    const normalized = normalizeMediaUrl(raw);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const decoded = decodeURIComponent(normalized);
    const base = decoded.split('/').pop();
    const fileMatch = base.match(/^(半身像|立绘|头像)_(.+?)_(skin\d+)\.png$/);
    if (!fileMatch) continue;
    images.push({
      kind: fileMatch[1], // 半身像 / 立绘 / 头像
      operator: fileMatch[2],
      skinKey: fileMatch[3],
      url: normalized,
    });
  }

  // 3. 详细表格：每个 h2 对应一个皮肤，提取干员名
  const h2Re = /<h2 id="([^"]+)"[^>]*>(?:<span[^>]*><\/span>)?([^<]+)<\/h2>/g;
  const details = [];
  let h2;
  while ((h2 = h2Re.exec(html)) !== null) {
    const start = h2.index;
    const nextIdx = html.indexOf('<h2 id="', start + 1);
    const block = html.slice(start, nextIdx > 0 ? nextIdx : html.length);
    const opMatch = block.match(/<a href="\/w\/([^"]+)" title="([^"]+)">/);
    details.push({
      skinName: h2[2].trim(),
      operator: opMatch ? decodeURIComponent(opMatch[2]) : '',
    });
  }

  return { cards, images, details };
}

function mergeSeries(series, parsed) {
  // 策略：按顺序把卡片（皮肤名）与 images 配对。
  // 一个皮肤通常有 半身像+立绘+头像 共 3 条 URL，因此 images 数量 ≈ cards*3。
  // 这里用更稳健的方式：根据 details 里的 skinName → operator 映射，
  // 再结合 images 里的 operator+skinKey 聚合成"干员皮肤条目"，
  // 最后把 series.cards 里的 skinName 按顺序分配给这些条目。
  const operatorBySkinName = new Map();
  for (const d of parsed.details) operatorBySkinName.set(d.skinName, d.operator);

  // 按 operator+skinKey 聚合成一条皮肤记录
  const byKey = new Map();
  for (const img of parsed.images) {
    const key = `${img.operator}_${img.skinKey}`;
    if (!byKey.has(key)) byKey.set(key, { operator: img.operator, skinKey: img.skinKey, images: {} });
    byKey.get(key).images[img.kind] = img.url;
  }
  const records = Array.from(byKey.values());

  // 按卡片顺序填充皮肤名；若 details 提供了 operator→skinName 则优先
  const assignedNames = new Map(); // key -> skinName
  for (const [skinName, op] of operatorBySkinName.entries()) {
    // 找到该 operator 的第一个未命名 key
    for (const rec of records) {
      if (rec.operator === op && !assignedNames.has(`${rec.operator}_${rec.skinKey}`)) {
        assignedNames.set(`${rec.operator}_${rec.skinKey}`, skinName);
        break;
      }
    }
  }
  // 剩余未命名的按 cards 顺序补
  const unnamed = records.filter((r) => !assignedNames.has(`${r.operator}_${r.skinKey}`));
  let cardIdx = 0;
  for (const rec of unnamed) {
    while (cardIdx < series.cards.length && assignedNames.has(`${rec.operator}_${rec.skinKey}`)) cardIdx++;
    if (cardIdx < series.cards.length) {
      assignedNames.set(`${rec.operator}_${rec.skinKey}`, series.cards[cardIdx].skinName);
      cardIdx++;
    }
  }

  const costumes = records.map((rec) => ({
    id: `${rec.operator}_${rec.skinKey}`,
    operator: rec.operator,
    skinKey: rec.skinKey,
    skinName: assignedNames.get(`${rec.operator}_${rec.skinKey}`) || rec.skinKey,
    series: series.name,
    brandEn: series.brandEn,
    bust: rec.images['半身像'] || null,
    full: rec.images['立绘'] || null,
    head: rec.images['头像'] || null,
  }));

  return costumes;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(opts.cacheDir, { recursive: true });
  await mkdir(dirname(opts.out), { recursive: true });

  console.log('fetching main page...');
  const mainHtml = await fetchText(MAIN_URL, join(opts.cacheDir, 'main.html'), opts);
  const seriesList = parseMainPage(mainHtml);
  console.log(`found ${seriesList.length} series, ${seriesList.reduce((a, s) => a + s.cards.length, 0)} skins`);

  const all = [];
  for (let i = 0; i < seriesList.length; i++) {
    const series = seriesList[i];
    const encodedName = encodeURIComponent(series.name);
    const url = `${SERIES_BASE}${encodedName}`;
    const cacheName = `series_${series.name.replace(/[^\w\u4e00-\u9fa5]+/g, '_')}.html`;
    console.log(`[${i + 1}/${seriesList.length}] ${series.name} (${series.cards.length})`);
    try {
      const html = await fetchText(url, join(opts.cacheDir, cacheName), opts);
      const parsed = parseSeriesPage(html, series.name);
      const costumes = mergeSeries(series, parsed);
      console.log(`    -> ${costumes.length} costume records`);
      all.push(...costumes);
    } catch (e) {
      console.error(`    ERROR: ${e.message}`);
    }
  }

  const output = {
    fetchedAt: new Date().toISOString(),
    source: MAIN_URL,
    count: all.length,
    costumes: all,
  };
  await writeFile(opts.out, JSON.stringify(output, null, 2), 'utf8');
  console.log(`wrote ${opts.out} with ${all.length} costumes`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// server/http/media.js — the extension-less audio route /media/… → public/assets/audio (see serveMedia),
// plus the 音乐盒 MOD's NetEase proxy `/media/netease/<songId>` (see serveRemoteTrack).
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)

import fsp from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTS } from '../../shared/media.js';
import { sendError } from './common.js';
import { serveFile } from './files.js';

// ---- 音乐盒 MOD: 外链音频代理 ------------------------------------------------------------------------------------
// `/media/netease/<songId>` → 网易云外链 `music.163.com/song/media/outer/url?id=<id>`，由服务器代取后同源回吐。
//
// 为什么需要绕这一圈：浏览器跨源 fetch 时，跳转链上的每一跳都得带 CORS 头。music.163.com 的 302 **不带**
// Access-Control-Allow-Origin（它跳到的 *.music.126.net CDN 反倒带 `*`），所以外链在页面里直接 fetch 只得到
// "Failed to fetch"。Node 不受 CORS 限制，替玩家把跳转解析掉即可，客户端拿到的是同源字节。
//
// 安全（这也是它只做这一件事的原因）：主机白名单只有网易云两个域名 ⇒ 拿不到内网/任意站点（不是 SSRF）；
// 只接受 audio/* 的响应类型；大小上限 40 MB；单次请求 20 s 超时。
const REMOTE_SEGMENT = 'netease';
const REMOTE_MAX_BYTES = 40 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 20000;
const REMOTE_MAX_HOPS = 5;
const REMOTE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** May this hop be fetched at all? Only the two NetEase hosts — anything else is refused (no SSRF). */
function remoteHostOk(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'music.163.com' || h === 'music.126.net' || h.endsWith('.music.126.net');
  } catch { return false; }
}

/**
 * Proxy one NetEase track (`/media/netease/<songId>`) for the 音乐盒 MOD.
 * @param {string} id the song id (digits)
 */
export async function serveRemoteTrack(req, res, id, log) {
  if (!/^\d{1,20}$/.test(String(id || ''))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  let buf = null;
  let type = 'audio/mpeg';
  try {
    let url = `https://music.163.com/song/media/outer/url?id=${id}`;
    for (let hop = 0; hop <= REMOTE_MAX_HOPS; hop += 1) {
      if (!remoteHostOk(url)) throw new Error('host not allowed');
      const r = await fetch(url, {
        headers: { 'User-Agent': REMOTE_UA, Referer: 'https://music.163.com/' },
        redirect: 'manual',
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) throw new Error(`HTTP ${r.status}`);
        url = new URL(loc, url).href;
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get('content-type') || '';
      // an empty type is allowed (a minimal upstream may omit it — same call as audio.js isAudioResponse)
      if (ct && !/^\s*audio\//i.test(ct)) throw new Error(`not audio: ${ct}`);
      if (ct) type = ct.split(';')[0].trim();
      const len = Number(r.headers.get('content-length'));
      if (Number.isFinite(len) && len > REMOTE_MAX_BYTES) throw new Error('too large');
      buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > REMOTE_MAX_BYTES) throw new Error('too large');
      break;
    }
  } catch (err) {
    log?.warn?.(`[media] remote track ${id} failed: ${err?.message || err}`);
    sendError(req, res, 502, '音频源不可用 · Upstream audio unavailable');
    return;
  }
  if (!buf) { sendError(req, res, 502, '音频源不可用 · Upstream audio unavailable'); return; }
  // same shape as the local route: an extension-less path (no download-manager sniffing) that answers audio/*
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(buf.length),
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'none',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  res.end(buf);
}

/**
 * Extension-less audio route: `/media/bgm/act1` → `public/assets/audio/bgm/act1.mp3`.
 *
 * Clients ask for audio through this path because download managers (IDM, 迅雷, FDM …) hijack XHR/fetch whose
 * URL ends in a media extension and pop a "下载文件信息" dialog for every BGM track — see `public/js/media.js`.
 * Requests for the direct `/assets/audio/…` URLs keep working (they are the fallback for plain static hosts).
 * `MEDIA_PREFIX` / `AUDIO_EXTS` live in `shared/media.js`: the browser decides which URLs to rewrite with the
 * same two values, and they must not drift apart.
 */
export async function serveMedia(req, res, rest, query, publicDir, gzipCache, log) {
  const root = path.join(path.resolve(publicDir), 'assets', 'audio');
  const segments = String(rest || '').split('/').filter((s) => s.length > 0);
  // 音乐盒 MOD 的外链代理（见 serveRemoteTrack）— 单曲 id 走路径 `/media/netease/<id>`，也认 `?id=` 查询串
  if (segments[0] === REMOTE_SEGMENT) {
    const id = segments.length === 2 ? segments[1] : new URLSearchParams(String(query || '')).get('id');
    await serveRemoteTrack(req, res, id, log);
    return;
  }
  if (!segments.length || rest.endsWith('/')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
  // A leading or trailing dot would address something else (dotfiles, "x..mp3") — and the client never asks for it.
  if (segments.some((s) => s.startsWith('.') || s.endsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }

  const last = segments[segments.length - 1];
  const given = path.extname(last).toLowerCase();
  const wanted = AUDIO_EXTS.includes(given) ? given : '';
  const stem = wanted ? last.slice(0, -wanted.length) : last;
  if (!stem || stem.startsWith('.')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  const dir = path.join(root, ...segments.slice(0, -1));
  if (dir !== root && !dir.startsWith(root + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

  // An explicit extension wins (`/media/bgm.ogg` → bgm.ogg), otherwise the usual order decides.
  const order = wanted ? [wanted, ...AUDIO_EXTS.filter((e) => e !== wanted)] : AUDIO_EXTS;
  for (const ext of order) {
    const absPath = path.join(dir, stem + ext);
    if (!absPath.startsWith(root + path.sep)) continue;
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fsp.stat(absPath);
    } catch { continue; }
    if (!stat.isFile()) continue;
    // serveFile decides Content-Type from the resolved name (`.mp3` → audio/mpeg) — Range/ETag handling is shared.
    // Cache policy is that of the public path the client would otherwise have asked for (`/assets/audio/…`, 1 day).
    // eslint-disable-next-line no-await-in-loop
    await serveFile(req, res, absPath, stat, 'public', ['assets', 'audio', ...segments], query, gzipCache, log);
    return;
  }
  sendError(req, res, 404, '页面不存在 · Not found');
}

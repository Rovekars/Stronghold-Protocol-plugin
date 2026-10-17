// 音乐盒 MOD 的外链音频代理 /media/netease/<songId>：主机白名单 / 只认 audio/* / 大小上限。
// 浏览器不能直接抓网易云外链（302 那一跳没有 CORS 头），所以服务器代取 —— 这里盯住这条代取链路的边界。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serveRemoteTrack } from '../server/http/media.js';

/** 最小的 req/res：够 sendError 与 serveRemoteTrack 用。 */
function fake() {
  const res = {
    status: 0, headers: null, body: null, headersSent: false, writes: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; this.writes += 1; },
    end(buf) { this.body = buf ?? null; },
    destroy() { this.destroyed = true; },
  };
  return { req: { method: 'GET', headers: {} }, res };
}

const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const LOG = { warn() {}, info() {}, error() {}, debug() {} };

/** 装一个假 fetch：responses 是按调用顺序给的响应（或抛错）。 */
function withFetch(responses, run) {
  const real = globalThis.fetch;
  let i = 0;
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url: String(url), redirect: opts?.redirect });
    const r = typeof responses === 'function' ? responses(i) : responses[i];
    i += 1;
    if (!r) throw new Error('unexpected fetch #' + i);
    return r;
  };
  return run(seen).finally(() => { globalThis.fetch = real; });
}

const okRes = (body, headers = {}) => ({
  ok: true, status: 200,
  headers: { get: (n) => ({ 'content-type': 'audio/mpeg', 'content-length': String(body.length), ...headers }[String(n).toLowerCase()] ?? null) },
  arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
});
const redir = (loc) => ({ ok: false, status: 302, headers: { get: (n) => (n.toLowerCase() === 'location' ? loc : null) } });

describe('音乐盒：/media/netease/<id> 外链代理', () => {
  test('song id 不是纯数字就当 404（不向外发请求）', async () => {
    await withFetch([], async (seen) => {
      for (const id of ['', 'abc', '12a', '../x']) {
        const { req, res } = fake();
        await serveRemoteTrack(req, res, id, LOG);
        assert.equal(res.status, 404, id);
      }
      assert.equal(seen.length, 0, 'never touches the network');
    });
  });

  test('正常曲目：同源回吐字节 + audio 类型', async () => {
    await withFetch([redir('http://m801.music.126.net/x.mp3'), okRes(MP3)], async (seen) => {
      const { req, res } = fake();
      await serveRemoteTrack(req, res, '3375918502', LOG);
      assert.equal(res.status, 200);
      assert.equal(res.headers['Content-Type'], 'audio/mpeg');
      assert.equal(res.headers['Accept-Ranges'], 'none');
      assert.equal(String(res.headers['Content-Length']), String(MP3.length));
      assert.equal(Buffer.compare(res.body, MP3), 0);
      assert.equal(seen.length, 2, '302 后再取一次');
      assert.match(seen[0].url, /^https:\/\/music\.163\.com\/song\/media\/outer\/url\?id=3375918502$/);
      assert.equal(seen[0].redirect, 'manual', '自己解析跳转，才不会被浏览器 CORS 规则卡住');
    });
  });

  test('跳转去白名单外的主机 → 502（不是任意代理 / 不是 SSRF）', async () => {
    await withFetch([redir('https://evil.example.com/a.mp3')], async (seen) => {
      const { req, res } = fake();
      await serveRemoteTrack(req, res, '3375918502', LOG);
      assert.equal(res.status, 502);
      assert.equal(seen.length, 1, '拒绝后再不往外发请求');
    });
  });

  test('上游不是音频 → 502', async () => {
    await withFetch([okRes(Buffer.from('<html>'), { 'content-type': 'text/html' })], async () => {
      const { req, res } = fake();
      await serveRemoteTrack(req, res, '3375918502', LOG);
      assert.equal(res.status, 502);
    });
  });

  test('超过 40MB → 502（先看 content-length，再看实际字节）', async () => {
    const declared = { ok: true, status: 200, headers: { get: (n) => (n.toLowerCase() === 'content-type' ? 'audio/mpeg' : n.toLowerCase() === 'content-length' ? String(41 * 1024 * 1024) : null) } };
    await withFetch([declared], async () => {
      const { req, res } = fake();
      await serveRemoteTrack(req, res, '3375918502', LOG);
      assert.equal(res.status, 502);
    });
  });

  test('上游失败（404 / 断网）→ 502，不抛异常', async () => {
    await withFetch([{ ok: false, status: 404, headers: { get: () => null } }], async () => {
      const { req, res } = fake();
      await serveRemoteTrack(req, res, '3375918502', LOG);
      assert.equal(res.status, 502);
    });
  });

  test('HEAD 不回正文', async () => {
    await withFetch([okRes(MP3)], async () => {
      const { res } = fake();
      await serveRemoteTrack({ method: 'HEAD', headers: {} }, res, '3375918502', LOG);
      assert.equal(res.status, 200);
      assert.equal(res.body, null);
    });
  });
});

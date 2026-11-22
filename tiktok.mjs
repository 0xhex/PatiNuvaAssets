#!/usr/bin/env node
/**
 * Pati Nuva — Resmi TikTok Content Posting API v2 istemcisi (OAuth Desktop PKCE + Video + Photo Carousel).
 *
 * Kurulum (tek seferlik):
 *   1) .env içine TIKTOK_CLIENT_KEY ve TIKTOK_CLIENT_SECRET ekle
 *   2) node tiktok.mjs auth
 *
 * Kullanım:
 *   node tiktok.mjs me
 *   node tiktok.mjs refresh
 *   node tiktok.mjs video videos/PN-016-yagmurluk-urun-videosu.mp4 --caption "..." [--direct] [--privacy SELF_ONLY] [--dry-run]
 *   node tiktok.mjs carousel PN-026-instagram [--direct] [--privacy SELF_ONLY] [--dry-run]
 *
 * Notlar:
 *   - Varsayılan mod Inbox / Taslak (video.upload): TikTok Audit onayı beklemeden çalışır,
 *     içerik TikTok hesabına taslak/bildirim olarak düşer.
 *   - --direct modu Direct Post (video.publish): Audit onayından sonra --privacy PUBLIC_TO_EVERYONE
 *     ile doğrudan herkese açık paylaşır (Audit öncesi yalnız gizli hesapta SELF_ONLY kabul eder).
 *   - Video yüklemesi FILE_UPLOAD kullanır (domain doğrulaması gerekmez).
 *   - Fotoğraf karuseli PULL_FROM_URL kullanır; TIKTOK_ASSETS_BASE altındaki URL önekinin
 *     TikTok Developer Portal -> URL properties bölümünde doğrulanmış olması gerekir.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '.env');
const API_BASE = 'https://open.tiktokapis.com';
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8787/callback/';
const DEFAULT_SCOPES = 'user.info.basic,video.upload,video.publish';
const DEFAULT_ASSETS_BASE = 'https://raw.githubusercontent.com/0xhex/PatiNuvaAssets/main';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function saveEnvVars(updates, file = ENV_FILE) {
  let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) continue;
    const formatted = `${k}=${String(v)}`;
    const idx = lines.findIndex((l) => l.trim().startsWith(`${k}=`));
    if (idx >= 0) lines[idx] = formatted;
    else lines.push(formatted);
    process.env[k] = String(v);
  }
  const text = lines.join('\n').replace(/\n*$/, '\n');
  fs.writeFileSync(file, text, 'utf8');
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Eksik ortam değişkeni: ${name} (.env dosyasına ekleyin)`);
  return v;
}

function randomVerifier(length = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

async function tokenRequest(params) {
  const res = await fetch(`${API_BASE}/v2/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`TikTok token geçersiz yanıt (${res.status}): ${text.slice(0, 300)}`); }
  if (!res.ok || json.error) {
    throw new Error(`TikTok OAuth hatası (${res.status}): ${json.error_description || json.error || text.slice(0, 300)}`);
  }
  return json;
}

function persistTokenPayload(tok) {
  const expiresAt = Date.now() + Math.max(60, (tok.expires_in || 86400) - 300) * 1000;
  saveEnvVars({
    TIKTOK_ACCESS_TOKEN: tok.access_token,
    TIKTOK_REFRESH_TOKEN: tok.refresh_token,
    TIKTOK_OPEN_ID: tok.open_id,
    TIKTOK_TOKEN_EXPIRES_AT: String(expiresAt),
  });
  return {
    openId: tok.open_id,
    scope: tok.scope,
    expiresInHours: Math.round((tok.expires_in || 0) / 3600),
    refreshExpiresInDays: Math.round((tok.refresh_expires_in || 0) / 86400),
  };
}

export async function refreshAccessToken() {
  loadEnv();
  const tok = await tokenRequest({
    client_key: requireEnv('TIKTOK_CLIENT_KEY'),
    client_secret: requireEnv('TIKTOK_CLIENT_SECRET'),
    grant_type: 'refresh_token',
    refresh_token: requireEnv('TIKTOK_REFRESH_TOKEN'),
  });
  return persistTokenPayload(tok);
}

export async function ensureToken() {
  loadEnv();
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const exp = Number(process.env.TIKTOK_TOKEN_EXPIRES_AT || 0);
  if (token && (!exp || Date.now() < exp)) return token;
  if (process.env.TIKTOK_REFRESH_TOKEN && process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET) {
    console.error('TikTok access token yenileniyor...');
    await refreshAccessToken();
    return process.env.TIKTOK_ACCESS_TOKEN;
  }
  throw new Error('TikTok yetkilendirmesi yok. Önce "node tiktok.mjs auth" çalıştırın.');
}

async function ttApi(pathname, { method = 'POST', body } = {}) {
  const token = await ensureToken();
  const res = await fetch(`${API_BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`TikTok API geçersiz yanıt (${res.status}): ${text.slice(0, 300)}`); }
  const errCode = json?.error?.code;
  if (!res.ok || (errCode && errCode !== 'ok')) {
    throw new Error(`TikTok API hata (${res.status} / ${errCode || 'unknown'}): ${json?.error?.message || text.slice(0, 300)}`);
  }
  return json.data;
}

export async function me() {
  const user = await ttApi('/v2/user/info/?fields=open_id,display_name,avatar_url', { method: 'GET' });
  let creator = null;
  try {
    creator = await ttApi('/v2/post/publish/creator_info/query/', { method: 'POST', body: {} });
  } catch (e) {
    creator = { error: e.message };
  }
  return { user: user?.user || user, creator };
}

async function waitPublish(publishId, timeoutMs = 5 * 60_000) {
  const start = Date.now();
  let last = '';
  while (Date.now() - start < timeoutMs) {
    const st = await ttApi('/v2/post/publish/status/fetch/', {
      method: 'POST',
      body: { publish_id: publishId },
    });
    if (st.status !== last) {
      console.error(`TikTok durum (${publishId}): ${st.status}`);
      last = st.status;
    }
    if (st.status === 'PUBLISH_COMPLETE' || st.status === 'SEND_TO_USER_INBOX') return st;
    if (st.status === 'FAILED') {
      throw new Error(`TikTok yayınlama başarısız: ${st.fail_reason || JSON.stringify(st)}`);
    }
    await sleep(5000);
  }
  throw new Error(`TikTok durum zaman aşımı (${publishId}, son durum: ${last})`);
}

function calcChunks(fileSize) {
  const MIN_CHUNK = 5 * 1024 * 1024;
  const MAX_SINGLE = 64 * 1024 * 1024;
  const DEFAULT_CHUNK = 10 * 1024 * 1024;
  if (fileSize <= MAX_SINGLE) {
    return { chunkSize: fileSize, totalChunkCount: 1 };
  }
  const chunkSize = Math.max(MIN_CHUNK, DEFAULT_CHUNK);
  const totalChunkCount = Math.max(1, Math.floor(fileSize / chunkSize));
  return { chunkSize, totalChunkCount };
}

/**
 * Yerel bir MP4 videoyu TikTok'a yükler (varsayılan: Inbox/Taslak; direct: true ise Direct Post).
 */
export async function publishVideo({
  videoPath,
  caption = '',
  direct = false,
  privacy = 'SELF_ONLY',
  dryRun = false,
}) {
  loadEnv();
  const abs = path.resolve(videoPath);
  if (!fs.existsSync(abs)) throw new Error(`Video bulunamadı: ${abs}`);
  const stat = fs.statSync(abs);
  const { chunkSize, totalChunkCount } = calcChunks(stat.size);

  const endpoint = direct ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/';
  const payload = {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: stat.size,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount,
    },
  };
  if (direct) {
    payload.post_info = {
      title: caption.slice(0, 2200),
      privacy_level: privacy,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false,
    };
  }

  if (dryRun) {
    return { dryRun: true, endpoint, videoPath: abs, videoSize: stat.size, payload };
  }

  const init = await ttApi(endpoint, { method: 'POST', body: payload });
  const { publish_id: publishId, upload_url: uploadUrl } = init;
  console.error(`TikTok video yükleniyor (${totalChunkCount} parça, ${(stat.size / 1e6).toFixed(2)} MB)...`);

  const buf = fs.readFileSync(abs);
  for (let i = 0; i < totalChunkCount; i++) {
    const start = i * chunkSize;
    const endExclusive = i === totalChunkCount - 1 ? buf.length : (i + 1) * chunkSize;
    const slice = buf.subarray(start, endExclusive);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${endExclusive - 1}/${buf.length}`,
      },
      body: slice,
    });
    if (put.status !== 201 && put.status !== 206) {
      throw new Error(`TikTok parça ${i + 1}/${totalChunkCount} yükleme hatası (${put.status}): ${(await put.text()).slice(0, 300)}`);
    }
  }
  console.error('TikTok dosya transferi tamamlandı, işleme bekleniyor...');
  const status = await waitPublish(publishId);
  return { publishId, mode: direct ? 'DIRECT_POST' : 'INBOX_UPLOAD', status };
}

/**
 * Bir klasördeki JPEG görsellerden TikTok Photo Mode karuseli yükler.
 * Görsellerin bulunduğu URL öneki TikTok Developer Portal -> URL properties kısmında doğrulanmış olmalıdır.
 */
export async function publishCarousel({
  dir,
  imageUrls,
  caption,
  title,
  direct = false,
  privacy = 'SELF_ONLY',
  autoAddMusic = true,
  dryRun = false,
}) {
  loadEnv();
  const base = (process.env.TIKTOK_ASSETS_BASE || process.env.RAW_BASE || DEFAULT_ASSETS_BASE).replace(/\/$/, '');
  let urls = imageUrls;
  let text = caption;

  if (!urls && dir) {
    const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, 35);
    if (!files.length) throw new Error(`Klasörde JPEG bulunamadı: ${dir}`);
    urls = files.map((f) => `${base}/${encodeURI(path.posix.join(dir, f))}`);
  }
  if (text === undefined && dir) {
    const capFile = path.join(dir, 'caption.txt');
    text = fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8').trim() : '';
  }

  for (const u of urls) {
    const res = await fetch(u, { method: 'HEAD' });
    if (!res.ok) throw new Error(`TikTok görseli erişilemiyor (${res.status}): ${u}`);
  }

  const firstLine = (title || (text || '').split(/\r?\n/).find((l) => l.trim()) || 'Pati Nuva').trim().slice(0, 90);
  const postInfo = {
    title: firstLine,
    description: (text || '').slice(0, 4000),
  };
  if (direct) {
    postInfo.privacy_level = privacy;
    postInfo.auto_add_music = autoAddMusic;
    postInfo.disable_comment = false;
    postInfo.brand_content_toggle = false;
    postInfo.brand_organic_toggle = true;
  }

  const payload = {
    media_type: 'PHOTO',
    post_mode: direct ? 'DIRECT_POST' : 'MEDIA_UPLOAD',
    post_info: postInfo,
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: urls,
    },
  };

  if (dryRun) {
    return { dryRun: true, endpoint: '/v2/post/publish/content/init/', payload };
  }

  const init = await ttApi('/v2/post/publish/content/init/', { method: 'POST', body: payload });
  const status = await waitPublish(init.publish_id);
  return { publishId: init.publish_id, mode: payload.post_mode, count: urls.length, status };
}

async function runAuth(scopes) {
  loadEnv();
  const clientKey = requireEnv('TIKTOK_CLIENT_KEY');
  const clientSecret = requireEnv('TIKTOK_CLIENT_SECRET');
  const redirectUri = process.env.TIKTOK_REDIRECT_URI || DEFAULT_REDIRECT_URI;
  const parsed = new URL(redirectUri);
  const host = parsed.hostname;
  const port = Number(parsed.port || 8787);
  const cbPath = parsed.pathname;

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = randomVerifier(64);
  // TikTok Desktop Login Kit PKCE hex-encoded SHA-256 gerektirir.
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('hex');

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_key', clientKey);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${host}:${port}`);
      if (reqUrl.pathname !== cbPath && reqUrl.pathname !== cbPath.replace(/\/$/, '')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const err = reqUrl.searchParams.get('error');
      const gotState = reqUrl.searchParams.get('state');
      const gotCode = reqUrl.searchParams.get('code');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>TikTok yetkilendirme hatası: ${err}</h2><p>${reqUrl.searchParams.get('error_description') || ''}</p>`);
        server.close();
        reject(new Error(`TikTok OAuth reddedildi: ${err} ${reqUrl.searchParams.get('error_description') || ''}`));
        return;
      }
      if (gotState !== state || !gotCode) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Geçersiz state veya code.');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>Pati Nuva TikTok bağlantısı tamamlandı!</h2><p>Bu sekmeyi kapatıp terminale dönebilirsiniz.</p>');
      server.close();
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(port, host, () => {
      console.error(`\nCallback dinleniyor: ${redirectUri}`);
      console.error(`Tarayıcıda açılıyor:\n${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });
  });

  const tok = await tokenRequest({
    client_key: clientKey,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const saved = persistTokenPayload(tok);
  let info = null;
  try { info = await me(); } catch (e) { info = { error: e.message }; }
  console.log(JSON.stringify({ saved, info }, null, 2));
}

// ---------------- CLI ----------------
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  loadEnv();
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };

  try {
    if (cmd === 'auth') {
      await runAuth(opt('--scopes', DEFAULT_SCOPES));
    } else if (cmd === 'refresh') {
      console.log(JSON.stringify(await refreshAccessToken(), null, 2));
    } else if (cmd === 'me') {
      console.log(JSON.stringify(await me(), null, 2));
    } else if (cmd === 'video') {
      const videoPath = args[0];
      if (!videoPath || videoPath.startsWith('--')) throw new Error('Kullanım: node tiktok.mjs video <dosya.mp4> [--caption "..."] [--direct] [--privacy SELF_ONLY] [--dry-run]');
      console.log(JSON.stringify(await publishVideo({
        videoPath,
        caption: opt('--caption', ''),
        direct: flag('--direct'),
        privacy: opt('--privacy', 'SELF_ONLY'),
        dryRun: flag('--dry-run'),
      }), null, 2));
    } else if (cmd === 'carousel') {
      const dir = args[0];
      if (!dir || dir.startsWith('--')) throw new Error('Kullanım: node tiktok.mjs carousel <klasör> [--direct] [--privacy SELF_ONLY] [--dry-run]');
      console.log(JSON.stringify(await publishCarousel({
        dir,
        caption: opt('--caption') ?? undefined,
        title: opt('--title') ?? undefined,
        direct: flag('--direct'),
        privacy: opt('--privacy', 'SELF_ONLY'),
        dryRun: flag('--dry-run'),
      }), null, 2));
    } else {
      console.error('Kullanım:\n  node tiktok.mjs auth [--scopes ...]\n  node tiktok.mjs me\n  node tiktok.mjs refresh\n  node tiktok.mjs video <dosya.mp4> [--caption "..."] [--direct] [--privacy SELF_ONLY] [--dry-run]\n  node tiktok.mjs carousel <klasör> [--direct] [--privacy SELF_ONLY] [--dry-run]');
      process.exit(2);
    }
  } catch (e) {
    console.error('HATA:', e.message || e);
    process.exit(1);
  }
}

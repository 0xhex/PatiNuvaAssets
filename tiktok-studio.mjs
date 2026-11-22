#!/usr/bin/env node
/**
 * Pati Nuva Publisher — TikTok Content Posting Studio (Desktop Companion UI)
 *
 * Implements TikTok Login Kit (OAuth 2.0 PKCE) and Content Posting API
 * (Draft / Inbox upload + Direct Post with full TikTok UX Guidelines compliance).
 *
 * Usage:
 *   node tiktok-studio.mjs [--port 8787] [--signed-out]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  loadEnv,
  me,
  publishVideo,
  publishCarousel,
  createAuthSession,
  completeAuthCode,
} from './tiktok.mjs';

loadEnv();

const ROOT = process.cwd();
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : 8787;
const HOST = '127.0.0.1';

let signedOut = args.includes('--signed-out');
const pendingAuth = new Map(); // state -> { codeVerifier, createdAt }
const jobs = new Map(); // jobId -> { id, status, mode, mediaType, publishId, detail, error, startedAt, finishedAt }

function listMedia() {
  const reelsDir = path.join(ROOT, 'reels');
  const videos = fs.existsSync(reelsDir)
    ? fs
        .readdirSync(reelsDir)
        .filter((f) => /\.mp4$/i.test(f))
        .sort()
        .map((f) => {
          const full = path.join(reelsDir, f);
          const stat = fs.statSync(full);
          return {
            name: f,
            relPath: path.posix.join('reels', f),
            sizeMB: Number((stat.size / 1e6).toFixed(2)),
          };
        })
    : [];

  const carousels = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /-instagram$/i.test(d.name))
    .map((d) => {
      const fullDir = path.join(ROOT, d.name);
      const slides = fs
        .readdirSync(fullDir)
        .filter((f) => /\.jpe?g$/i.test(f))
        .sort();
      const capFile = path.join(fullDir, 'caption.txt');
      const caption = fs.existsSync(capFile) ? fs.readFileSync(capFile, 'utf8').trim() : '';
      return {
        dir: d.name,
        slides: slides.map((s) => path.posix.join(d.name, s)),
        caption,
      };
    })
    .filter((c) => c.slides.length > 0)
    .sort((a, b) => a.dir.localeCompare(b.dir));

  return { videos, carousels };
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStaticFile(res, absPath, req) {
  if (!absPath.startsWith(ROOT) || !fs.existsSync(absPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(absPath).toLowerCase();
  const mime =
    ext === '.mp4'
      ? 'video/mp4'
      : ext === '.png'
      ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : 'application/octet-stream';

  const stat = fs.statSync(absPath);
  const range = req.headers.range;
  if (range && ext === '.mp4') {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
    });
    fs.createReadStream(absPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
  });
  fs.createReadStream(absPath).pipe(res);
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Pati Nuva Publisher — TikTok Content Studio</title>
<style>
  :root {
    --bg: #f6f7f5;
    --card: #ffffff;
    --brand: #1e2e26;
    --brand-soft: #eef3f0;
    --tiktok: #fe2c55;
    --tiktok-dark: #e02046;
    --text: #161823;
    --muted: #646875;
    --border: #e5e7eb;
    --ok: #10b981;
    --warn: #d97706;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.45;
  }
  header {
    background: var(--brand);
    color: #fff;
    padding: 14px 28px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-shadow: 0 2px 10px rgba(0,0,0,0.08);
  }
  .brand-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-left img {
    width: 38px;
    height: 38px;
    border-radius: 10px;
    object-fit: cover;
    background: #fff;
    padding: 2px;
  }
  .brand-title { font-weight: 700; font-size: 17px; letter-spacing: -0.2px; }
  .brand-sub { font-size: 12px; color: #b7c9bf; }
  .badge {
    font-size: 11px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255,255,255,0.14);
    color: #fff;
    border: 1px solid rgba(255,255,255,0.2);
  }
  main {
    max-width: 1160px;
    margin: 22px auto 48px;
    padding: 0 20px;
    display: grid;
    grid-template-columns: 390px 1fr;
    gap: 20px;
    align-items: start;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px 20px;
    box-shadow: 0 1px 3px rgba(16,24,40,0.04);
  }
  .card + .card { margin-top: 16px; }
  h2 {
    margin: 0 0 12px;
    font-size: 15px;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .account-box {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    border-radius: 12px;
    background: var(--brand-soft);
    border: 1px solid #d7e3dc;
  }
  .account-box img {
    width: 48px;
    height: 48px;
    border-radius: 50%;
    object-fit: cover;
    border: 2px solid #fff;
  }
  .account-name { font-weight: 700; font-size: 15px; }
  .account-handle { font-size: 12.5px; color: var(--muted); }
  .scope-pills {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .pill {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 6px;
    background: #f1f5f9;
    color: #334155;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .pill.ok { background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    border: none;
    border-radius: 10px;
    padding: 10px 16px;
    font-size: 13.5px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }
  .btn-tiktok { background: var(--tiktok); color: #fff; width: 100%; }
  .btn-tiktok:hover:not(:disabled) { background: var(--tiktok-dark); }
  .btn-tiktok:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-outline {
    background: #fff;
    color: var(--text);
    border: 1px solid var(--border);
    padding: 7px 12px;
    font-size: 12.5px;
  }
  .btn-outline:hover { background: #f9fafb; }
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    background: #f1f3f5;
    padding: 4px;
    border-radius: 10px;
    gap: 4px;
    margin-bottom: 14px;
  }
  .tab {
    border: none;
    background: transparent;
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--muted);
    cursor: pointer;
  }
  .tab.active {
    background: #fff;
    color: var(--text);
    box-shadow: 0 1px 2px rgba(0,0,0,0.08);
  }
  label.field-label {
    display: block;
    font-size: 12.5px;
    font-weight: 600;
    margin: 12px 0 6px;
    color: #2b2f3a;
  }
  select, textarea, input[type="text"] {
    width: 100%;
    padding: 9px 11px;
    border: 1px solid #d1d5db;
    border-radius: 9px;
    font-size: 13.5px;
    font-family: inherit;
    background: #fff;
    color: var(--text);
  }
  select:focus, textarea:focus, input[type="text"]:focus {
    outline: none;
    border-color: var(--brand);
    box-shadow: 0 0 0 3px rgba(30,46,38,0.12);
  }
  textarea { min-height: 92px; resize: vertical; }
  .preview-wrap {
    margin-top: 12px;
    background: #111;
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 280px;
    max-height: 360px;
  }
  .preview-wrap video {
    max-width: 100%;
    max-height: 360px;
    display: block;
  }
  .carousel-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding: 8px;
    width: 100%;
    background: #f8fafc;
  }
  .carousel-grid img {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid var(--border);
  }
  .meta-line {
    font-size: 12px;
    color: var(--muted);
    margin-top: 8px;
    display: flex;
    justify-content: space-between;
  }
  .checks {
    display: flex;
    gap: 18px;
    flex-wrap: wrap;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fafafa;
  }
  .checks label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13.5px;
    cursor: pointer;
  }
  .checks label.disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 11px 13px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: #fafafa;
    margin-top: 12px;
  }
  .disclosure-box {
    margin-top: 10px;
    padding: 12px 14px;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    background: #f8fafc;
    display: none;
  }
  .disclosure-box.open { display: block; }
  .disclosure-opt {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    margin-bottom: 10px;
    font-size: 13px;
  }
  .disclosure-opt:last-child { margin-bottom: 0; }
  .disclosure-note {
    margin-top: 8px;
    font-size: 12px;
    padding: 8px 10px;
    border-radius: 8px;
    background: #fef3c7;
    color: #92400e;
    border: 1px solid #fde68a;
  }
  .consent-box {
    margin: 14px 0;
    padding: 11px 13px;
    border-radius: 10px;
    background: #f1f5f9;
    font-size: 12.5px;
    color: #334155;
  }
  .consent-box a { color: var(--brand); font-weight: 600; }
  .status-panel {
    margin-top: 14px;
    padding: 13px 15px;
    border-radius: 10px;
    border: 1px solid var(--border);
    background: #fafafa;
    display: none;
  }
  .status-panel.show { display: block; }
  .status-panel.ok { background: #ecfdf5; border-color: #a7f3d0; }
  .status-panel.err { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
  .status-title { font-weight: 700; font-size: 13.5px; margin-bottom: 4px; }
  .status-sub { font-size: 12.5px; color: #374151; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .hidden { display: none !important; }
  .helper { font-size: 12px; color: var(--muted); margin-top: 4px; }
</style>
</head>
<body>
<header>
  <div class="brand-left">
    <img src="/asset/logo" alt="Pati Nuva" />
    <div>
      <div class="brand-title">Pati Nuva Publisher</div>
      <div class="brand-sub">Official TikTok Content Posting Desktop App • patinuva.com</div>
    </div>
  </div>
  <span class="badge">TikTok API v2 • Sandbox Environment</span>
</header>

<main>
  <!-- LEFT COLUMN: Account & Media Selector -->
  <div>
    <div class="card">
      <h2>
        <span>TikTok Account (Login Kit)</span>
        <button id="btnSignOut" class="btn btn-outline hidden" type="button">Disconnect</button>
      </h2>

      <div id="authDisconnected">
        <p style="font-size:13px;color:var(--muted);margin:0 0 12px;">
          Connect your TikTok creator account with OAuth 2.0 PKCE to view creator settings and publish product videos or photo carousels.
        </p>
        <button id="btnConnect" class="btn btn-tiktok" type="button">
          Continue with TikTok
        </button>
      </div>

      <div id="authConnected" class="hidden">
        <div class="account-box">
          <img id="acctAvatar" src="" alt="avatar" />
          <div>
            <div class="account-name" id="acctName">—</div>
            <div class="account-handle" id="acctHandle">@—</div>
            <div style="font-size:11.5px;color:#047857;font-weight:600;margin-top:2px;" id="acctMaxDur">Max video duration: —</div>
          </div>
        </div>
        <div class="scope-pills">
          <span class="pill ok">user.info.basic ✓</span>
          <span class="pill ok">video.upload ✓</span>
          <span class="pill ok">video.publish ✓</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Content Library</h2>
      <div class="tabs">
        <button class="tab active" id="tabMediaVideo" type="button">Video (.mp4)</button>
        <button class="tab" id="tabMediaPhoto" type="button">Photo Carousel</button>
      </div>

      <div id="videoSelector">
        <label class="field-label" for="videoSelect">Select product video</label>
        <select id="videoSelect"></select>
        <div class="preview-wrap">
          <video id="videoPreview" controls muted playsinline></video>
        </div>
        <div class="meta-line">
          <span id="videoSizeLabel">—</span>
          <span id="videoDurLabel">Duration: —</span>
        </div>
      </div>

      <div id="photoSelector" class="hidden">
        <label class="field-label" for="carouselSelect">Select photo carousel folder</label>
        <select id="carouselSelect"></select>
        <div class="preview-wrap" style="background:#f8fafc;min-height:180px;">
          <div id="carouselPreview" class="carousel-grid"></div>
        </div>
        <div class="meta-line">
          <span id="carouselCountLabel">—</span>
          <span>Source: PULL_FROM_URL (Verified)</span>
        </div>
      </div>
    </div>
  </div>

  <!-- RIGHT COLUMN: Publish Settings (TikTok Content Sharing UX Guidelines) -->
  <div class="card">
    <h2>
      <span>Publish Settings (Content Posting API)</span>
      <span id="postingAsBadge" class="pill">Not connected</span>
    </h2>

    <div class="tabs">
      <button class="tab active" id="tabModeInbox" type="button">Upload as Draft (video.upload)</button>
      <button class="tab" id="tabModeDirect" type="button">Direct Post (video.publish)</button>
    </div>

    <div id="inboxNotice" class="consent-box" style="margin-top:0;background:#eef3f0;border:1px solid #d7e3dc;">
      <strong>Draft / Inbox Upload (<span class="mono">video.upload</span>):</strong>
      Sends your video or photo carousel directly to your TikTok Inbox so you can add trending music, stickers, and finalize your post inside the TikTok app.
    </div>

    <div id="directControls" class="hidden">
      <label class="field-label" for="captionInput">Title / Caption</label>
      <textarea id="captionInput" maxlength="2200" placeholder="Write your TikTok caption and hashtags..."></textarea>
      <div class="meta-line">
        <span>Visible on TikTok profile after publishing</span>
        <span id="captionCounter">0 / 2200</span>
      </div>

      <label class="field-label" for="privacySelect">Who can watch this post *</label>
      <select id="privacySelect">
        <option value="">-- Select privacy level --</option>
      </select>
      <div class="helper" id="privacyHelper">Options are loaded live from your TikTok creator settings (<span class="mono">creator_info/query</span>).</div>

      <label class="field-label">Allow users to</label>
      <div class="checks">
        <label id="lblComment"><input type="checkbox" id="chkComment" /> Comment</label>
        <label id="lblDuet"><input type="checkbox" id="chkDuet" /> Duet</label>
        <label id="lblStitch"><input type="checkbox" id="chkStitch" /> Stitch</label>
      </div>

      <div class="toggle-row">
        <div>
          <div style="font-size:13.5px;font-weight:600;">Disclose video content</div>
          <div style="font-size:12px;color:var(--muted);">Turn on to indicate this content promotes yourself, a brand, product, or service.</div>
        </div>
        <input type="checkbox" id="chkDisclosure" style="width:18px;height:18px;cursor:pointer;" />
      </div>

      <div id="disclosureBox" class="disclosure-box">
        <div class="disclosure-opt">
          <input type="checkbox" id="chkYourBrand" style="margin-top:3px;" />
          <label for="chkYourBrand" style="cursor:pointer;">
            <strong>Your brand</strong><br/>
            <span style="color:var(--muted);font-size:12px;">You are promoting yourself or your own business (Pati Nuva). Classified as Brand Organic.</span>
          </label>
        </div>
        <div class="disclosure-opt">
          <input type="checkbox" id="chkBrandedContent" style="margin-top:3px;" />
          <label for="chkBrandedContent" style="cursor:pointer;">
            <strong>Branded content</strong><br/>
            <span style="color:var(--muted);font-size:12px;">You are promoting another brand or a third party. Classified as Branded Content.</span>
          </label>
        </div>
        <div id="disclosureLabelNote" class="disclosure-note hidden"></div>
      </div>

      <div id="consentBox" class="consent-box">
        By posting, you agree to TikTok's
        <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.
      </div>
    </div>

    <button id="btnPublish" class="btn btn-tiktok" type="button" disabled>
      Upload Draft to TikTok Inbox
    </button>
    <div id="validationHint" class="helper" style="color:var(--warn);"></div>

    <div id="statusPanel" class="status-panel">
      <div class="status-title" id="statusTitle">Uploading...</div>
      <div class="status-sub" id="statusSub"></div>
    </div>
  </div>
</main>

<script>
let state = {
  connected: false,
  user: null,
  creator: null,
  mediaType: 'video', // 'video' | 'photo'
  mode: 'inbox', // 'inbox' | 'direct'
  media: { videos: [], carousels: [] },
  videoDurationSec: null,
  busy: false,
};

const PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Everyone (Public)',
  MUTUAL_FOLLOW_FRIENDS: 'Friends (Mutual followers)',
  FOLLOWER_OF_CREATOR: 'Followers',
  SELF_ONLY: 'Only me (Private)',
};

const $ = (id) => document.getElementById(id);

async function init() {
  const [acctRes, mediaRes] = await Promise.all([
    fetch('/api/account').then((r) => r.json()),
    fetch('/api/media').then((r) => r.json()),
  ]);
  state.media = mediaRes;
  populateMedia();

  if (acctRes.connected) {
    state.connected = true;
    state.user = acctRes.user;
    state.creator = acctRes.creator;
    renderAccount();
  } else {
    renderDisconnected();
  }
  updateUI();
}

function renderDisconnected() {
  $('authDisconnected').classList.remove('hidden');
  $('authConnected').classList.add('hidden');
  $('btnSignOut').classList.add('hidden');
  $('postingAsBadge').textContent = 'Not connected';
  $('postingAsBadge').className = 'pill';
}

function renderAccount() {
  $('authDisconnected').classList.add('hidden');
  $('authConnected').classList.remove('hidden');
  $('btnSignOut').classList.remove('hidden');
  const displayName = state.creator?.creator_nickname || state.user?.display_name || 'TikTok Creator';
  const username = state.creator?.creator_username ? '@' + state.creator.creator_username : state.user?.open_id || '';
  $('acctAvatar').src = state.user?.avatar_url || state.creator?.creator_avatar_url || '/asset/logo';
  $('acctName').textContent = displayName;
  $('acctHandle').textContent = username;
  const maxSec = state.creator?.max_video_post_duration_sec || 600;
  $('acctMaxDur').textContent = 'Max video duration: ' + Math.round(maxSec / 60) + ' min (' + maxSec + 's)';
  $('postingAsBadge').textContent = 'Posting as ' + (username || displayName);
  $('postingAsBadge').className = 'pill ok';

  // Populate privacy options dynamically from creator_info/query (NO default pre-selected!)
  const sel = $('privacySelect');
  sel.innerHTML = '<option value="">-- Select privacy level --</option>';
  const opts = state.creator?.privacy_level_options || ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'];
  for (const opt of opts) {
    const o = document.createElement('option');
    o.value = opt;
    o.textContent = PRIVACY_LABELS[opt] || opt;
    sel.appendChild(o);
  }

  // Respect creator interaction disables (unchecked by default per TikTok guidelines)
  applyInteractionToggle('chkComment', 'lblComment', Boolean(state.creator?.comment_disabled));
  applyInteractionToggle('chkDuet', 'lblDuet', Boolean(state.creator?.duet_disabled));
  applyInteractionToggle('chkStitch', 'lblStitch', Boolean(state.creator?.stitch_disabled));
}

function applyInteractionToggle(chkId, lblId, disabledByCreator) {
  const chk = $(chkId);
  const lbl = $(lblId);
  chk.checked = false;
  chk.disabled = disabledByCreator;
  lbl.classList.toggle('disabled', disabledByCreator);
}

function populateMedia() {
  const vsel = $('videoSelect');
  vsel.innerHTML = '';
  for (const v of state.media.videos) {
    const o = document.createElement('option');
    o.value = v.relPath;
    o.textContent = v.name + ' (' + v.sizeMB + ' MB)';
    vsel.appendChild(o);
  }
  const csel = $('carouselSelect');
  csel.innerHTML = '';
  for (const c of state.media.carousels) {
    const o = document.createElement('option');
    o.value = c.dir;
    o.textContent = c.dir + ' (' + c.slides.length + ' photos)';
    csel.appendChild(o);
  }
  onVideoChanged();
  onCarouselChanged();
}

function onVideoChanged() {
  const rel = $('videoSelect').value;
  const item = state.media.videos.find((v) => v.relPath === rel);
  if (!item) return;
  $('videoSizeLabel').textContent = 'Size: ' + item.sizeMB + ' MB';
  const vid = $('videoPreview');
  vid.src = '/asset/file?p=' + encodeURIComponent(item.relPath);
  vid.onloadedmetadata = () => {
    state.videoDurationSec = Math.round(vid.duration);
    $('videoDurLabel').textContent = 'Duration: ' + state.videoDurationSec + 's';
    updateUI();
  };
  if (!$('captionInput').value.trim()) {
    $('captionInput').value = 'Pati Nuva yeni sezon koleksiyonu! patinuva.com #patinuva #kopek #petshop';
    $('captionCounter').textContent = $('captionInput').value.length + ' / 2200';
  }
}

function onCarouselChanged() {
  const dir = $('carouselSelect').value;
  const item = state.media.carousels.find((c) => c.dir === dir);
  if (!item) return;
  $('carouselCountLabel').textContent = item.slides.length + ' JPEG slides';
  const grid = $('carouselPreview');
  grid.innerHTML = '';
  for (const s of item.slides.slice(0, 6)) {
    const img = document.createElement('img');
    img.src = '/asset/file?p=' + encodeURIComponent(s);
    grid.appendChild(img);
  }
  if (state.mediaType === 'photo' && item.caption) {
    $('captionInput').value = item.caption;
    $('captionCounter').textContent = $('captionInput').value.length + ' / 2200';
  }
}

function updateUI() {
  $('tabMediaVideo').classList.toggle('active', state.mediaType === 'video');
  $('tabMediaPhoto').classList.toggle('active', state.mediaType === 'photo');
  $('videoSelector').classList.toggle('hidden', state.mediaType !== 'video');
  $('photoSelector').classList.toggle('hidden', state.mediaType !== 'photo');

  $('tabModeInbox').classList.toggle('active', state.mode === 'inbox');
  $('tabModeDirect').classList.toggle('active', state.mode === 'direct');
  $('inboxNotice').classList.toggle('hidden', state.mode !== 'inbox');
  $('directControls').classList.toggle('hidden', state.mode !== 'direct');

  // Hide Duet & Stitch for photo posts
  $('lblDuet').classList.toggle('hidden', state.mediaType === 'photo');
  $('lblStitch').classList.toggle('hidden', state.mediaType === 'photo');

  // Commercial disclosure rules
  const discOn = $('chkDisclosure').checked;
  const yourBrand = $('chkYourBrand').checked;
  const branded = $('chkBrandedContent').checked;
  $('disclosureBox').classList.toggle('open', discOn);

  // Disable SELF_ONLY when Branded Content is selected
  const privSel = $('privacySelect');
  const selfOpt = [...privSel.options].find((o) => o.value === 'SELF_ONLY');
  if (selfOpt) {
    selfOpt.disabled = discOn && branded;
    selfOpt.textContent =
      discOn && branded
        ? 'Only me (Private) — unavailable for Branded Content'
        : PRIVACY_LABELS.SELF_ONLY;
    if (discOn && branded && privSel.value === 'SELF_ONLY') {
      privSel.value = '';
    }
  }

  const labelNote = $('disclosureLabelNote');
  if (discOn && branded) {
    labelNote.textContent = 'Your ' + (state.mediaType === 'video' ? 'video' : 'photo') + ' will be labeled as "Paid partnership". Branded content visibility cannot be set to private.';
    labelNote.classList.remove('hidden');
  } else if (discOn && yourBrand) {
    labelNote.textContent = 'Your ' + (state.mediaType === 'video' ? 'video' : 'photo') + ' will be labeled as "Promotional content".';
    labelNote.classList.remove('hidden');
  } else {
    labelNote.classList.add('hidden');
  }

  // Update Music Usage / Branded Content declaration
  if (discOn && branded) {
    $('consentBox').innerHTML =
      'By posting, you agree to TikTok\\'s <a href="https://www.tiktok.com/legal/page/global/bc-policy/en" target="_blank" rel="noreferrer">Branded Content Policy</a> and <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.';
  } else {
    $('consentBox').innerHTML =
      'By posting, you agree to TikTok\\'s <a href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en" target="_blank" rel="noreferrer">Music Usage Confirmation</a>.';
  }

  // Button label & validation
  const btn = $('btnPublish');
  const hint = $('validationHint');
  btn.textContent =
    state.mode === 'inbox'
      ? 'Upload Draft to TikTok Inbox'
      : 'Publish Directly to TikTok';

  let reason = '';
  if (!state.connected) {
    reason = 'Connect your TikTok account via Login Kit first.';
  } else if (state.busy) {
    reason = 'Publishing in progress...';
  } else if (
    state.mediaType === 'video' &&
    state.videoDurationSec &&
    state.creator?.max_video_post_duration_sec &&
    state.videoDurationSec > state.creator.max_video_post_duration_sec
  ) {
    reason = 'Selected video exceeds your account max duration.';
  } else if (state.mode === 'direct') {
    if (!privSel.value) {
      reason = 'Please select a privacy level before publishing.';
    } else if (discOn && !yourBrand && !branded) {
      reason = 'You need to indicate if your content promotes yourself, a third party, or both.';
    }
  }
  btn.disabled = Boolean(reason);
  hint.textContent = reason;
}

$('btnConnect').onclick = () => {
  window.location.href = '/auth/start';
};
$('btnSignOut').onclick = async () => {
  await fetch('/auth/disconnect', { method: 'POST' });
  state.connected = false;
  state.user = null;
  state.creator = null;
  renderDisconnected();
  updateUI();
};

$('tabMediaVideo').onclick = () => { state.mediaType = 'video'; updateUI(); };
$('tabMediaPhoto').onclick = () => { state.mediaType = 'photo'; onCarouselChanged(); updateUI(); };
$('tabModeInbox').onclick = () => { state.mode = 'inbox'; updateUI(); };
$('tabModeDirect').onclick = () => { state.mode = 'direct'; updateUI(); };

$('videoSelect').onchange = onVideoChanged;
$('carouselSelect').onchange = onCarouselChanged;
$('captionInput').oninput = () => {
  $('captionCounter').textContent = $('captionInput').value.length + ' / 2200';
};
$('privacySelect').onchange = updateUI;
$('chkDisclosure').onchange = updateUI;
$('chkYourBrand').onchange = updateUI;
$('chkBrandedContent').onchange = updateUI;

$('btnPublish').onclick = async () => {
  state.busy = true;
  updateUI();
  const panel = $('statusPanel');
  panel.className = 'status-panel show';
  $('statusTitle').textContent = 'Initializing TikTok Content Posting API...';
  $('statusSub').textContent = 'Starting upload...';

  const body = {
    mediaType: state.mediaType,
    mode: state.mode,
    videoPath: $('videoSelect').value,
    carouselDir: $('carouselSelect').value,
    caption: $('captionInput').value,
    privacy: $('privacySelect').value || 'SELF_ONLY',
    disableComment: !$('chkComment').checked,
    disableDuet: !$('chkDuet').checked,
    disableStitch: !$('chkStitch').checked,
    brandOrganicToggle: $('chkDisclosure').checked && $('chkYourBrand').checked,
    brandContentToggle: $('chkDisclosure').checked && $('chkBrandedContent').checked,
  };

  try {
    const res = await fetch('/api/publish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    if (res.error) throw new Error(res.error);
    pollJob(res.jobId);
  } catch (e) {
    panel.className = 'status-panel show err';
    $('statusTitle').textContent = 'Upload failed';
    $('statusSub').textContent = e.message;
    state.busy = false;
    updateUI();
  }
};

async function pollJob(jobId) {
  const panel = $('statusPanel');
  while (true) {
    const job = await fetch('/api/jobs/' + jobId).then((r) => r.json());
    if (job.status === 'DONE') {
      panel.className = 'status-panel show ok';
      const finalStatus = job.result?.status?.status || 'COMPLETED';
      const pubId = job.result?.publishId || '';
      $('statusTitle').textContent =
        finalStatus === 'SEND_TO_USER_INBOX'
          ? 'Uploaded to TikTok Inbox (Draft Ready)'
          : 'Published to TikTok (' + finalStatus + ')';
      $('statusSub').innerHTML =
        'Publish ID: <span class="mono">' +
        pubId +
        '</span><br/>' +
        (finalStatus === 'SEND_TO_USER_INBOX'
          ? 'Open the TikTok app → Inbox → System Notifications to review and post your draft.'
          : 'Your content has been submitted. It may take a few minutes to finish processing and appear on your TikTok profile.');
      state.busy = false;
      updateUI();
      return;
    }
    if (job.status === 'ERROR') {
      panel.className = 'status-panel show err';
      $('statusTitle').textContent = 'Publish Error';
      $('statusSub').textContent = job.error || 'Unknown error';
      state.busy = false;
      updateUI();
      return;
    }
    $('statusTitle').textContent = 'TikTok Status: ' + (job.ttStatus || job.status);
    $('statusSub').innerHTML = job.publishId
      ? 'Publish ID: <span class="mono">' + job.publishId + '</span> — polling /v2/post/publish/status/fetch/...'
      : 'Transferring media chunks to TikTok...';
    await new Promise((r) => setTimeout(r, 1200));
  }
}

init();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && pathname === '/asset/logo') {
      serveStaticFile(res, path.join(ROOT, 'deri-kayis-instagram', 'pati-nuva-logo-white.png'), req);
      return;
    }

    if (req.method === 'GET' && pathname === '/asset/file') {
      const rel = url.searchParams.get('p') || '';
      const abs = path.resolve(ROOT, rel);
      serveStaticFile(res, abs, req);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/media') {
      sendJson(res, 200, listMedia());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/account') {
      if (signedOut || !process.env.TIKTOK_ACCESS_TOKEN) {
        sendJson(res, 200, { connected: false });
        return;
      }
      try {
        const info = await me();
        sendJson(res, 200, { connected: true, ...info });
      } catch (e) {
        sendJson(res, 200, { connected: false, error: e.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/auth/start') {
      const sess = createAuthSession();
      pendingAuth.set(sess.state, { codeVerifier: sess.codeVerifier, createdAt: Date.now() });
      res.writeHead(302, { Location: sess.authUrl });
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/disconnect') {
      signedOut = true;
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && (pathname === '/callback' || pathname === '/callback/')) {
      const err = url.searchParams.get('error');
      const stateParam = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>TikTok Authorization Cancelled</h2><p>${err}</p><a href="/">Return to Pati Nuva Publisher</a>`);
        return;
      }
      const sess = pendingAuth.get(stateParam);
      if (!sess || !code) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid OAuth state or code.');
        return;
      }
      pendingAuth.delete(stateParam);
      await completeAuthCode({ code, codeVerifier: sess.codeVerifier });
      signedOut = false;
      res.writeHead(302, { Location: '/?connected=1' });
      res.end();
      return;
    }

    if (req.method === 'POST' && pathname === '/api/publish') {
      const body = await readJsonBody(req);
      const jobId = crypto.randomBytes(8).toString('hex');
      const job = {
        id: jobId,
        status: 'RUNNING',
        ttStatus: 'INIT',
        publishId: null,
        result: null,
        error: null,
      };
      jobs.set(jobId, job);

      const onStatus = (st) => {
        if (st?.status) job.ttStatus = st.status;
        if (st?.publish_id) job.publishId = st.publish_id;
      };

      const direct = body.mode === 'direct';
      const task =
        body.mediaType === 'photo'
          ? publishCarousel({
              dir: body.carouselDir,
              caption: body.caption,
              direct,
              privacy: body.privacy,
              disableComment: body.disableComment,
              brandOrganicToggle: body.brandOrganicToggle,
              brandContentToggle: body.brandContentToggle,
              onStatus,
            })
          : publishVideo({
              videoPath: body.videoPath,
              caption: body.caption,
              direct,
              privacy: body.privacy,
              disableComment: body.disableComment,
              disableDuet: body.disableDuet,
              disableStitch: body.disableStitch,
              brandOrganicToggle: body.brandOrganicToggle,
              brandContentToggle: body.brandContentToggle,
              onStatus,
            });

      task
        .then((result) => {
          job.status = 'DONE';
          job.publishId = result.publishId;
          job.result = result;
        })
        .catch((e) => {
          job.status = 'ERROR';
          job.error = e.message;
        });

      sendJson(res, 200, { jobId });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
      const id = pathname.slice('/api/jobs/'.length);
      const job = jobs.get(id);
      if (!job) {
        sendJson(res, 404, { error: 'Job not found' });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Pati Nuva Publisher Studio running at http://${HOST}:${PORT}/`);
});

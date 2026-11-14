#!/usr/bin/env node
/**
 * Bir klasördeki JPEG görsellerden Instagram carousel postu paylaşır.
 *
 *   INSTAGRAM_TOKEN=... node ig-carousel.mjs PN-026-instagram [--dry-run]
 *
 * Görseller herkese açık olmalı (Meta sunucuları indirir); bu yüzden klasörün
 * GitHub'a push'lanmış olması gerekir. Açıklama klasördeki caption.txt'den okunur.
 * Instagram: yalnızca JPEG, en/boy oranı 4:5 ile 1.91:1 arası, en fazla 10 görsel.
 */
import fs from 'node:fs';
import path from 'node:path';

const [dir, ...rest] = process.argv.slice(2);
const dryRun = rest.includes('--dry-run');
if (!dir) {
  console.error('Kullanım: node ig-carousel.mjs <klasör> [--dry-run]');
  process.exit(2);
}

const RAW_BASE = process.env.RAW_BASE || 'https://raw.githubusercontent.com/0xhex/PatiNuvaAssets/main';
const BASE = `https://graph.instagram.com/${process.env.IG_GRAPH_VERSION || 'v22.0'}`;
const token = process.env.INSTAGRAM_TOKEN || process.env.IG_ACCESS_TOKEN;

const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, 10);
const caption = fs.readFileSync(path.join(dir, 'caption.txt'), 'utf8').trim();
const urls = files.map((f) => `${RAW_BASE}/${encodeURI(path.posix.join(dir, f))}`);

for (const u of urls) {
  const res = await fetch(u, { method: 'HEAD' });
  if (!res.ok) throw new Error(`Görsel erişilemiyor (${res.status}): ${u}`);
}
console.error(`${urls.length} görsel erişilebilir.`);
if (dryRun) {
  console.log(JSON.stringify({ urls, caption }, null, 2));
  process.exit(0);
}
if (!token) throw new Error('INSTAGRAM_TOKEN tanımlı değil');

async function ig(pathname, params = {}, method = 'POST') {
  const url = new URL(`${BASE}/${pathname}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const json = await res.json();
  if (json.error) throw new Error(`Instagram hata ${json.error.code}: ${json.error.error_user_msg || json.error.message}`);
  return json;
}

async function waitReady(id) {
  for (let i = 0; i < 30; i++) {
    const { status_code } = await ig(id, { fields: 'status_code' }, 'GET');
    if (status_code === 'FINISHED') return;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`Konteyner ${id}: ${status_code}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Konteyner ${id} zaman aşımı`);
}

const me = await ig('me', { fields: 'id,username' }, 'GET');
console.error(`Hesap: @${me.username}`);

const children = [];
for (const image_url of urls) {
  const { id } = await ig(`${me.id}/media`, { image_url, is_carousel_item: 'true' });
  await waitReady(id);
  children.push(id);
  console.error(`Görsel hazır: ${id}`);
}

const carousel = await ig(`${me.id}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption });
await waitReady(carousel.id);
const { id: mediaId } = await ig(`${me.id}/media_publish`, { creation_id: carousel.id });
const { permalink } = await ig(mediaId, { fields: 'permalink' }, 'GET');
console.log(JSON.stringify({ mediaId, permalink }, null, 2));

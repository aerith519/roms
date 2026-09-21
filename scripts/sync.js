#!/usr/bin/env node
/**
 * Reads your UploadG drive and writes files.json for the static site.
 * Runs in GitHub Actions only — the API token never reaches the browser.
 *
 * Env:
 *   UPLOADG_TOKEN   required, from uploadg.com/account-settings -> Developers
 *   ROOT_FOLDER_ID  optional, only publish this folder (and its children)
 *   SHARE_BASE      optional, public share URL prefix (default below)
 */

import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://uploadg.com/api/v1';
const TOKEN = process.env.UPLOADG_TOKEN;
const ROOT_FOLDER_ID = process.env.ROOT_FOLDER_ID || null;
// CONFIRM THIS: open any share link in the UploadG web UI and copy the part
// before the hash. Everything else in this script is spec-accurate.
const SHARE_BASE = process.env.SHARE_BASE || 'https://uploadg.com/drive/s';
const OUT = 'files.json';

if (!TOKEN) {
  console.error('UPLOADG_TOKEN is not set.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, options = {}, attempt = 0) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get('Retry-After') || 5);
    console.warn(`Rate limited on ${path}; waiting ${wait}s`);
    await sleep(wait * 1000);
    return api(path, options, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method || 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res.json();
}

/** Every page of one folder. */
async function listFolder(folderId) {
  const entries = [];
  let page = 1;
  let lastPage = 1;

  do {
    const params = new URLSearchParams({
      section: folderId ? 'folder' : 'home',
      page: String(page),
      perPage: '100',
      orderBy: 'updated_at',
      orderDir: 'desc',
    });
    if (folderId) params.set('folderId', String(folderId));

    const data = await api(`/drive/file-entries?${params}`);
    entries.push(...(data.data || []));
    lastPage = data.last_page || 1;
    page += 1;
  } while (page <= lastPage);

  return entries;
}

/** Walk the whole tree, depth-first, recording each entry's path. */
async function walk(folderId, trail, out) {
  const entries = await listFolder(folderId);

  for (const entry of entries) {
    if (entry.type === 'folder') {
      out.push({ ...entry, path: trail });
      await walk(entry.id, [...trail, entry.name], out);
    } else {
      out.push({ ...entry, path: trail });
    }
  }
}

/**
 * Public download link for one file. Reuses whatever we published last run so
 * we aren't asking for the same link every five minutes.
 */
async function shareLink(id, cached) {
  if (cached) return cached;

  let { link } = await api(`/file-entries/${id}/shareable-link`);
  if (!link) {
    ({ link } = await api(`/file-entries/${id}/shareable-link`, {
      method: 'POST',
      body: JSON.stringify({ allowDownload: true, allowEdit: false }),
    }));
  }
  return link?.hash ? `${SHARE_BASE}/${link.hash}` : null;
}

async function previous() {
  try {
    const raw = JSON.parse(await readFile(OUT, 'utf8'));
    return new Map((raw.files || []).map((f) => [f.id, f.url]));
  } catch {
    return new Map();
  }
}

const cache = await previous();
const raw = [];
await walk(ROOT_FOLDER_ID, [], raw);

const files = [];
for (const entry of raw) {
  const isFolder = entry.type === 'folder';
  files.push({
    id: entry.id,
    name: entry.name,
    folder: isFolder,
    path: entry.path,
    size: isFolder ? null : entry.file_size ?? 0,
    extension: entry.extension || null,
    modified: entry.updated_at || entry.created_at || null,
    description: entry.description || null,
    url: isFolder ? null : await shareLink(entry.id, cache.get(entry.id)),
  });
}

files.sort((a, b) => {
  if (a.folder !== b.folder) return a.folder ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
});

const next = { files };
const prevRaw = await readFile(OUT, 'utf8').catch(() => '');

// Compare without the timestamp so an unchanged drive makes no commit.
let prevFiles = '';
try {
  prevFiles = JSON.stringify(JSON.parse(prevRaw).files);
} catch {
  prevFiles = '';
}

if (prevFiles === JSON.stringify(next.files)) {
  console.log(`No changes (${files.length} entries).`);
  process.exit(0);
}

next.generated = new Date().toISOString();
await writeFile(OUT, JSON.stringify(next, null, 2) + '\n');
console.log(`Wrote ${files.length} entries to ${OUT}.`);

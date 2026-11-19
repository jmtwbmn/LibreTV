import { execFile } from 'node:child_process';
import type { SourceConfig } from '@/lib/types';

/**
 * 苹果CMS v10 采集接口适配器（LibreTV 云端 / 本地共用）
 * ------------------------------------------------------------
 * 把 NHK World-Japan / NFB / Ani-One / 链接源(NFB、TV5MONDE、Tubi、TubiSteamy)
 * 这些「网站 / YouTube 频道」包装成 LibreTV 能吃的苹果CMS v10 采集接口：
 *   GET /api/cms-adapter/<provider>[/<tag>]?ac=videolist&wd=关键词&pg=1   -> 搜索
 *   GET /api/cms-adapter/<provider>[/<tag>]?ac=videolist&ids=视频ID       -> 详情(取直链)
 *
 * 设计要点：
 * - NHK、NFB 纯 fetch / 常量实现，Vercel 云端（无 yt-dlp）可直接用；
 * - Ani-One、links 依赖 yt-dlp（先试 env YTDLP，再试 PATH 里的 yt-dlp），
 *   云端没有 yt-dlp 时优雅降级：搜索记为空并跳过，详情把错误写进简介，绝不 500；
 * - 所有 provider 的 search 都 try/catch，接口始终返回 200 合法 JSON。
 */

// ---------- 对外数据结构（苹果CMS v10 兼容） ----------

export interface CmsVod {
  vod_id: string;
  vod_name: string;
  vod_pic: string;
  vod_remarks: string;
  type_name: string;
  vod_year: string;
  vod_area: string;
  vod_lang: string;
  vod_actor: string;
  vod_director: string;
  vod_content: string;
  vod_play_from: string;
  vod_play_url: string;
}

export interface CmsListResponse {
  code: number;
  msg: string;
  page: number;
  pagecount: number;
  limit: string;
  total: number;
  list: CmsVod[];
}

interface Episode {
  name: string;
  url: string;
}

interface ProviderItem {
  native: string;
  name: string;
  pic?: string;
  remarks?: string;
  typeName?: string;
  year?: string;
  area?: string;
  desc?: string;
  episodes?: Episode[];
}

interface DetailResult {
  name?: string;
  pic?: string;
  desc?: string;
  episodes: Episode[];
}

interface Provider {
  search(kw: string, tag: string): Promise<ProviderItem[]>;
  detail(native: string): Promise<DetailResult>;
}

/** 内部缓存记录：搜索时落缓存，详情时补齐/复用元数据 */
interface CachedRecord {
  vodId: string;
  provider: string;
  native: string;
  name: string;
  pic: string;
  remarks: string;
  typeName: string;
  year: string;
  area: string;
  desc: string;
  episodes: Episode[];
}

// ---------- id 编解码（必须匹配 /^[\w-]+$/） ----------

function b64e(s: string): string {
  return Buffer.from(String(s), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64d(s: string): string {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  return Buffer.from(t, 'base64').toString('utf8');
}

function mkId(provider: string, native: string): string {
  return `${provider}-${b64e(native)}`;
}

function parseId(vodId: string): { provider: string; native: string } | null {
  const i = vodId.indexOf('-');
  if (i < 0) return null;
  try {
    return { provider: vodId.slice(0, i), native: b64d(vodId.slice(i + 1)) };
  } catch {
    return null;
  }
}

// ---------- yt-dlp（可选；云端缺失时优雅降级） ----------

let ytdlpCandidatesCache: string[] | null = null;

function ytdlpCandidates(): string[] {
  if (!ytdlpCandidatesCache) {
    const list: string[] = [];
    if (process.env.YTDLP) list.push(process.env.YTDLP);
    list.push('yt-dlp');
    ytdlpCandidatesCache = list;
  }
  return ytdlpCandidatesCache;
}

function lastLine(input: string | Buffer | null | undefined): string {
  if (!input) return '';
  const lines = String(input)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function execFileP(file: string, args: string[], timeout = 60000): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const e: Error & { code?: string | number } = new Error(
            lastLine(stderr) || err.message || 'yt-dlp 执行失败'
          );
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== undefined) e.code = code;
          reject(e);
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

/**
 * 依次尝试候选二进制：env YTDLP -> 'yt-dlp'。
 * 某一候选 ENOENT（不存在）则换下一个；其它错误直接抛。
 * 全部候选都不存在时抛错（被上层 try/catch 吞掉）。
 */
async function runYtdlp(args: string[], timeout = 60000): Promise<string> {
  let missing = true;
  let lastErr: unknown = null;
  for (const bin of ytdlpCandidates()) {
    try {
      return await execFileP(bin, args, timeout);
    } catch (e) {
      const code = (e as { code?: string | number }).code;
      if (code === 'ENOENT') {
        lastErr = e;
        continue;
      }
      missing = false;
      throw e;
    }
  }
  if (missing) {
    const detail = lastErr instanceof Error ? `: ${lastErr.message}` : '';
    throw new Error(`未找到 yt-dlp（serverless 环境通常不可用）${detail}`);
  }
  throw new Error('yt-dlp 不可用');
}

// ---------- NHK World-Japan（纯常量，无外部依赖） ----------

const NHK_LIVE = 'https://media-tyo.hls.nhkworld.jp/hls/w/live/master.m3u8';
const NHK_PATTERN = /(nhk|japan|world|日本|新闻|新聞|紀錄|纪录|live|直播)/;

const nhkProvider: Provider = {
  async search(kw: string): Promise<ProviderItem[]> {
    const k = (kw || '').toLowerCase();
    if (k && !NHK_PATTERN.test(k)) return [];
    return [
      {
        native: 'live',
        name: 'NHK World-Japan 直播',
        remarks: 'LIVE',
        typeName: '直播',
        area: '日本',
        episodes: [{ name: '直播', url: NHK_LIVE }],
      },
    ];
  },
  async detail(): Promise<DetailResult> {
    return {
      name: 'NHK World-Japan 直播',
      episodes: [{ name: '直播', url: NHK_LIVE }],
    };
  },
};

// ---------- NFB（纯 fetch：解析 embed 播放器页里的 window.IFRAME_OPTIONS.source） ----------

interface NfbEntry {
  slug: string;
  title: string;
  typeName: string;
  area: string;
  pic?: string;
}

const NFB_CATALOG: NfbEntry[] = [
  { slug: 'ryan', title: 'Ryan', typeName: '动画短片', area: '加拿大' },
  { slug: 'bread-will-walk', title: 'Bread Will Walk', typeName: '纪录片', area: '加拿大' },
  { slug: 'the-girl-who-cried-pearls', title: 'The Girl Who Cried Pearls', typeName: '动画短片', area: '加拿大' },
  { slug: 'neighbours', title: 'Neighbours', typeName: '动画短片', area: '加拿大' },
  { slug: 'the-cat-came-back', title: 'The Cat Came Back', typeName: '动画短片', area: '加拿大' },
  { slug: 'the-sweater', title: 'The Sweater', typeName: '动画短片', area: '加拿大' },
  { slug: 'christmas-cracker', title: 'Christmas Cracker', typeName: '动画短片', area: '加拿大' },
  { slug: 'the-big-snore', title: 'The Big Snore', typeName: '动画短片', area: '加拿大' },
  { slug: 'madame-tutli-putli', title: 'Madame Tutli-Putli', typeName: '动画短片', area: '加拿大' },
  { slug: 'the-log-drivers-waltz', title: "The Log Driver's Waltz", typeName: '动画短片', area: '加拿大' },
  { slug: 'the-street', title: 'The Street', typeName: '动画短片', area: '加拿大' },
  { slug: 'pas-de-deux', title: 'Pas de deux', typeName: '动画短片', area: '加拿大' },
  { slug: 'the-house-that-jack-built', title: 'The House That Jack Built', typeName: '动画短片', area: '加拿大' },
  { slug: 'special-delivery', title: 'Special Delivery', typeName: '动画短片', area: '加拿大' },
];

function findNfb(slug: string): NfbEntry | undefined {
  return NFB_CATALOG.find((e) => e.slug === slug);
}

/** 从 embed 页 HTML 里定位 window.IFRAME_OPTIONS = {...} 并做括号配对解析出 source */
function extractIframeSource(html: string): string | undefined {
  const anchor = html.indexOf('window.IFRAME_OPTIONS');
  if (anchor < 0) return undefined;
  const start = html.indexOf('{', anchor);
  if (start < 0) return undefined;

  let depth = 0;
  let end = -1;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return undefined;

  try {
    const obj = JSON.parse(html.slice(start, end)) as { source?: unknown };
    return typeof obj.source === 'string' && obj.source ? obj.source : undefined;
  } catch {
    return undefined;
  }
}

/** 从任意输入里提取 NFB slug：支持裸 slug 或完整影片页 URL */
function nfbSlugOf(native: string): string {
  const raw = String(native).trim();
  const m = raw.match(/\/film\/([^/?#]+)/);
  return (m ? m[1] : raw).replace(/\/+$/, '');
}

const nfbProvider: Provider = {
  async search(kw: string): Promise<ProviderItem[]> {
    const k = (kw || '').trim();
    if (k) {
      try {
        const u = `https://publicapi.nfb.ca/api/v5/films?locale=en&query=${encodeURIComponent(k)}&size=20&page=1&subset=nfb/published`;
        const r = await fetch(u, {
          headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
          cache: 'no-store',
        });
        if (r.ok) {
          const j = (await r.json()) as {
            items?: Array<{ slug?: string; title?: string; thumbnail?: string; year?: number }>;
          };
          const items: ProviderItem[] = (j.items || [])
            .filter((it) => it && typeof it.slug === 'string' && it.slug)
            .map((it) => ({
              native: String(it.slug),
              name: `NFB - ${it.title || it.slug}`,
              pic: it.thumbnail ? `https://assets.nfbcdn.ca/medias/norman/${it.thumbnail}?w=300` : '',
              remarks: 'NFB',
              typeName: '影片',
              area: '加拿大',
              year: it.year ? String(it.year) : '',
            }));
          if (items.length) return items;
        }
      } catch {
        /* 回退精选目录 */
      }
    }
    const kk = k.toLowerCase();
    return NFB_CATALOG.filter(
      (e) =>
        !kk ||
        e.title.toLowerCase().includes(kk) ||
        e.slug.toLowerCase().includes(kk) ||
        e.typeName.toLowerCase().includes(kk) ||
        e.area.toLowerCase().includes(kk)
    ).map((e) => ({
      native: e.slug,
      name: `NFB - ${e.title}`,
      pic: e.pic || '',
      remarks: 'NFB',
      typeName: e.typeName,
      area: e.area,
    }));
  },
  async detail(native: string): Promise<DetailResult> {
    const slug = nfbSlugOf(native);
    if (!slug) throw new Error('无效的 NFB slug');
    const meta = findNfb(slug);
    const res = await fetch(`https://www.nfb.ca/film/${encodeURIComponent(slug)}/embed/player/`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en' },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`NFB embed 页请求失败 HTTP ${res.status}`);
    const html = await res.text();
    const source = extractIframeSource(html);
    if (!source) throw new Error('未找到播放源（可能为付费/受限影片）');
    const url = source.split('#')[0];
    if (!/^https?:\/\//.test(url)) throw new Error('NFB 播放源格式异常');
    return { name: meta?.title, pic: meta?.pic, episodes: [{ name: '播放', url }] };
  },
};

// ---------- Ani-One（YouTube 频道；依赖 yt-dlp） ----------

const ANIONE_CHANNEL = 'https://www.youtube.com/c/AniOneAnime';

const anioneProvider: Provider = {
  async search(kw: string): Promise<ProviderItem[]> {
    if (!kw) return [];
    const out = await runYtdlp([
      '--no-warnings',
      '--flat-playlist',
      '--playlist-end',
      '15',
      '--print',
      '%(id)s\t%(title)s',
      `${ANIONE_CHANNEL}/search?query=${encodeURIComponent(kw)}`,
    ]);
    return out
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((a) => a.length >= 2 && a[0] && a[1])
      .map((a) => ({
        native: `yt:${a[0]}`,
        name: a[1],
        pic: `https://i.ytimg.com/vi/${a[0]}/hqdefault.jpg`,
        remarks: 'Ani-One',
        typeName: '动画',
        area: '日本',
      }));
  },
  async detail(native: string): Promise<DetailResult> {
    const vid = String(native).replace(/^yt:/, '');
    const page = /^https?:\/\//.test(String(native))
      ? String(native)
      : `https://www.youtube.com/watch?v=${vid}`;
    const out = await runYtdlp(['--no-warnings', '--no-playlist', '-f', 'b', '-g', page]);
    const url = out
      .split('\n')
      .map((s) => s.trim())
      .find((s) => /^https?:\/\//.test(s));
    if (!url) throw new Error('yt-dlp 未返回可用直链');
    return { episodes: [{ name: '播放', url }] };
  },
};

// ---------- links（NFB / TV5MONDE / Tubi / TubiSteamy 占位链接源；依赖 yt-dlp） ----------

interface LinkRow {
  tag: string;
  name: string;
  url: string;
  typeName: string;
  area: string;
  remarks?: string;
}

const LINK_ROWS: LinkRow[] = [
  { tag: 'NFB', name: 'NFB 加拿大国家电影局', url: 'https://www.nfb.ca/', typeName: '纪录片', area: '加拿大' },
  { tag: 'TV5MONDE', name: 'TV5MONDEplus（占位，需梯子+地区）', url: 'https://www.tv5mondeplus.com/', typeName: '影片', area: '法国' },
  { tag: 'Tubi', name: 'Tubi（占位，需美国 IP）', url: 'https://tubitv.com/', typeName: '电影', area: '美国' },
  { tag: 'TubiSteamy', name: 'TubiSteamy（占位，需美国 IP）', url: 'https://tubitv.com/', typeName: '电影', area: '美国' },
];

const linksProvider: Provider = {
  async search(kw: string, tag: string): Promise<ProviderItem[]> {
    const k = (kw || '').trim().toLowerCase();
    return LINK_ROWS.filter((r) => !tag || r.tag === tag)
      .filter(
        (r) =>
          !k ||
          r.name.toLowerCase().includes(k) ||
          r.tag.toLowerCase().includes(k) ||
          r.typeName.toLowerCase().includes(k)
      )
      .map((r) => ({
        native: r.url,
        name: r.name,
        remarks: r.remarks || r.tag,
        typeName: r.typeName,
        area: r.area,
      }));
  },
  async detail(native: string): Promise<DetailResult> {
    const out = await runYtdlp(['--no-warnings', '--no-playlist', '-f', 'b', '-g', String(native)]);
    const url = out
      .split('\n')
      .map((s) => s.trim())
      .find((s) => /^https?:\/\//.test(s));
    if (!url) throw new Error('yt-dlp 未返回可用直链');
    return { episodes: [{ name: '播放', url }] };
  },
};

// ---------- provider 表 ----------

const providers: Record<string, Provider> = {
  nhk: nhkProvider,
  nfb: nfbProvider,
  anione: anioneProvider,
  links: linksProvider,
};

// ---------- 缓存与组装 ----------

const cache = new Map<string, CachedRecord>();
const CACHE_LIMIT = 800;

function pruneCache(): void {
  if (cache.size <= CACHE_LIMIT) return;
  const extra = cache.size - CACHE_LIMIT;
  const keys = Array.from(cache.keys()).slice(0, extra);
  for (const k of keys) cache.delete(k);
}

function toVod(rec: CachedRecord): CmsVod {
  const eps = (rec.episodes || []).filter((e) => /^https?:\/\//.test(e.url));
  return {
    vod_id: rec.vodId,
    vod_name: rec.name || '未命名',
    vod_pic: rec.pic || '',
    vod_remarks: rec.remarks || '',
    type_name: rec.typeName || '',
    vod_year: rec.year || '',
    vod_area: rec.area || '',
    vod_lang: '',
    vod_actor: '',
    vod_director: '',
    vod_content: rec.desc || '',
    vod_play_from: 'adapter',
    vod_play_url: eps.map((e) => `${e.name || '播放'}$${e.url}`).join('#'),
  };
}

function cmsBody(records: CachedRecord[], page: number, note: string): CmsListResponse {
  const list = records.map(toVod);
  return {
    code: 1,
    msg: note,
    page: page || 1,
    pagecount: 1,
    limit: '20',
    total: list.length,
    list,
  };
}

/** 缓存缺失时按 provider 从静态目录补元数据（NFB / NHK / links），尽量让详情完整 */
function fallbackMeta(
  provider: string,
  native: string,
  vodId: string
): Partial<CachedRecord> {
  if (provider === 'nfb') {
    const entry = findNfb(nfbSlugOf(native));
    if (entry) {
      return {
        name: entry.title,
        pic: entry.pic || '',
        remarks: 'NFB',
        typeName: entry.typeName,
        area: entry.area,
      };
    }
  }
  if (provider === 'nhk') {
    return { name: 'NHK World-Japan 直播', remarks: 'LIVE', typeName: '直播', area: '日本' };
  }
  if (provider === 'links') {
    const row = LINK_ROWS.find((r) => r.url === native);
    if (row) {
      return {
        name: row.name,
        remarks: row.remarks || row.tag,
        typeName: row.typeName,
        area: row.area,
      };
    }
  }
  return {};
}

async function runSearch(
  providerKey: string,
  tag: string,
  wd: string,
  pg: number
): Promise<CmsListResponse> {
  const keys = providerKey ? [providerKey] : Object.keys(providers);
  const records: CachedRecord[] = [];
  let known = false;

  for (const key of keys) {
    const p = providers[key];
    if (!p) continue;
    known = true;
    let items: ProviderItem[] = [];
    try {
      items = await p.search(wd, tag);
    } catch (e) {
      // provider 搜索失败：跳过，绝不影响其它 provider / 整体 200
      console.warn(`[cms-adapter] provider "${key}" 搜索失败: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const it of items) {
      const native = it.native != null ? it.native : 'x';
      const vodId = mkId(key, native);
      const rec: CachedRecord = {
        vodId,
        provider: key,
        native,
        name: it.name || '未命名',
        pic: it.pic || '',
        remarks: it.remarks || '',
        typeName: it.typeName || '',
        year: it.year || '',
        area: it.area || '',
        desc: it.desc || '',
        episodes: it.episodes || [],
      };
      cache.set(vodId, rec);
      records.push(rec);
    }
  }

  pruneCache();

  if (providerKey && !known) {
    return cmsBody([], pg, `未知源: ${providerKey}`);
  }
  return cmsBody(records, pg, records.length ? '数据列表' : '无结果');
}

async function runDetail(idsStr: string): Promise<CmsListResponse> {
  const ids = String(idsStr)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const records: CachedRecord[] = [];

  for (const vodId of ids) {
    const info = parseId(vodId);
    const provider = info?.provider || '';
    const native = info?.native || '';
    const p = providers[provider];
    const cached = cache.get(vodId);

    const rec: CachedRecord = cached
      ? { ...cached, vodId, provider, native }
      : {
          vodId,
          provider,
          native,
          name: vodId,
          pic: '',
          remarks: '',
          typeName: '',
          year: '',
          area: '',
          desc: '',
          episodes: [],
        };

    if (!cached) {
      Object.assign(rec, fallbackMeta(provider, native, vodId));
    }

    if (p) {
      try {
        const d = await p.detail(native);
        if (d) {
          if (d.name) rec.name = d.name;
          if (d.pic) rec.pic = d.pic;
          if (d.desc) rec.desc = d.desc;
          if (Array.isArray(d.episodes) && d.episodes.length) rec.episodes = d.episodes;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        rec.desc = `${rec.desc || ''} [解析失败: ${msg}]`.trim();
        console.warn(`[cms-adapter] detail "${vodId}" 失败: ${msg}`);
      }
    }

    records.push(rec);
  }

  return cmsBody(records, 1, records.length ? '数据列表' : '无结果');
}

/**
 * 路由入口：解析 <provider>[/<tag>] 与 ac/wd/ids/pg，返回苹果CMS v10 结构。
 * 任何异常都兜底成 200 合法 JSON（code:1, list:[]）。
 */
export async function handleCmsAdapter(req: Request, segments: string[]): Promise<CmsListResponse> {
  try {
    const url = new URL(req.url);
    const providerKey = (segments[0] || '').trim();
    const tag = (segments[1] || '').trim();

    const ids = url.searchParams.get('ids') || url.searchParams.get('id') || '';
    if (ids) return await runDetail(ids);

    const wd = url.searchParams.get('wd') || url.searchParams.get('key') || '';
    const pgRaw = parseInt(url.searchParams.get('pg') || '1', 10);
    const pg = Number.isFinite(pgRaw) && pgRaw > 0 ? pgRaw : 1;
    return await runSearch(providerKey, tag, wd, pg);
  } catch (e) {
    console.error('[cms-adapter] 未捕获异常:', e);
    return cmsBody([], 1, `adapter error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 生成 6 个适配器源（供 /api/status 之类注入到默认采集站）。
 * 用请求自身的 origin 拼绝对地址，云端 / 本地都能正确指回自己。
 */
export function getAdapterSources(req: Request): SourceConfig[] {
  const origin = new URL(req.url).origin;
  return [
    { key: 'adapter_0', name: 'NHK World', url: `${origin}/api/cms-adapter/nhk` },
    { key: 'adapter_1', name: 'NFB', url: `${origin}/api/cms-adapter/nfb` },
    { key: 'adapter_2', name: 'Ani-One', url: `${origin}/api/cms-adapter/anione` },
    { key: 'adapter_3', name: 'TV5MONDE', url: `${origin}/api/cms-adapter/links/TV5MONDE` },
    { key: 'adapter_4', name: 'Tubi', url: `${origin}/api/cms-adapter/links/Tubi` },
    { key: 'adapter_5', name: 'TubiSteamy', url: `${origin}/api/cms-adapter/links/TubiSteamy`, isAdult: true },
  ];
}

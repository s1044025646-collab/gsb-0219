import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { ApiError } from './errors';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  file: string | null;
  ref: string | null;
}

export interface ManifestItem {
  id: string;
  href: string;
  mediaType: string;
  properties: string[];
}

export interface NavNode {
  label: string;
  href: string | null;
  children: NavNode[];
}

export interface EpubStructure {
  opfPath: string;
  title: string | null;
  author: string | null;
  language: string | null;
  manifest: ManifestItem[];
  spine: { idref: string; href: string | null }[];
  navPath: string | null;
  navTree: NavNode[];
  issues: Issue[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false,
  removeNSPrefix: true,
  isArray: () => false,
});

const navParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  removeNSPrefix: true,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && '#text' in (v as Record<string, unknown>)) {
    return String((v as Record<string, unknown>)['#text']);
  }
  return null;
}

/** 以 baseDir（包内目录）为基准解析相对路径；越界返回 null。 */
export function resolvePackagePath(baseDir: string, rel: string): string | null {
  const decoded = decodeURIComponent(rel.split('#')[0].split('?')[0]);
  const parts = (baseDir ? baseDir + '/' + decoded : decoded).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(p);
    }
  }
  return out.join('/');
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function isRemote(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

export async function loadZip(buf: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw new ApiError('INVALID_ZIP', '无法解析 ZIP/EPUB 文件');
  }
}

function parseXml(xml: string, file: string): Record<string, unknown> {
  try {
    return xmlParser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ApiError('INVALID_XML', `XML 解析失败: ${file}`);
  }
}

async function readEntry(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  if (!f) return null;
  return f.async('string');
}

function collectIds(xml: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) ids.add(m[1]);
  return ids;
}

interface OrderedNode {
  [tag: string]: unknown;
  ':@'?: Record<string, unknown>;
}

function attrsOf(node: OrderedNode): Record<string, unknown> {
  return node[':@'] ?? {};
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  return asArray(node[tag] as OrderedNode | OrderedNode[] | undefined);
}

function findNavList(nodes: OrderedNode[]): OrderedNode[] | null {
  for (const n of nodes) {
    if (typeof n !== 'object' || n === null) continue;
    for (const key of Object.keys(n)) {
      if (key === ':@') continue;
      if (key === 'nav') {
        const attrs = attrsOf(n);
        const type = String(attrs['@_epub:type'] ?? attrs['@_type'] ?? '');
        if (type.split(/\s+/).includes('toc')) {
          for (const k of asArray(n[key] as OrderedNode | OrderedNode[])) {
            if (typeof k === 'object' && k !== null && 'ol' in k) {
              return asArray((k as OrderedNode).ol as OrderedNode | OrderedNode[]);
            }
          }
        }
      }
      const found = findNavList(asArray(n[key] as OrderedNode | OrderedNode[]));
      if (found) return found;
    }
  }
  return null;
}
function textOfOrdered(kids: unknown[]): string {
  let out = '';
  for (const k of kids) {
    if (typeof k === 'object' && k !== null && '#text' in (k as Record<string, unknown>)) {
      out += String((k as Record<string, unknown>)['#text']);
    }
  }
  return out;
}

function liToNavNode(liWrapper: OrderedNode): NavNode {
  const kids = asArray(liWrapper.li as OrderedNode | OrderedNode[]);
  let label = '';
  let href: string | null = null;
  const children: NavNode[] = [];
  for (const k of kids) {
    if (typeof k !== 'object' || k === null) continue;
    if ('a' in k) {
      href = String(attrsOf(k)['@_href'] ?? '') || null;
      label = textOfOrdered(asArray((k as OrderedNode).a));
    } else if ('span' in k) {
      label = textOfOrdered(asArray((k as OrderedNode).span));
    } else if ('ol' in k) {
      const olKids = asArray((k as OrderedNode).ol as OrderedNode | OrderedNode[]);
      children.push(...olKids.filter((c): c is OrderedNode => typeof c === 'object' && c !== null).map(liToNavNode));
    }
  }
  return { label: label.trim(), href, children };
}
function flattenNav(nodes: NavNode[], out: NavNode[] = []): NavNode[] {
  for (const n of nodes) {
    out.push(n);
    flattenNav(n.children, out);
  }
  return out;
}

export async function parseEpub(buf: Buffer): Promise<EpubStructure> {
  const zip = await loadZip(buf);
  const issues: Issue[] = [];
  const add = (code: string, severity: Severity, message: string, file: string | null, ref: string | null) =>
    issues.push({ code, severity, message, file, ref });

  const containerXml = await readEntry(zip, 'META-INF/container.xml');
  if (containerXml === null) {
    throw new ApiError('CONTAINER_MISSING', '缺少 META-INF/container.xml');
  }
  const container = parseXml(containerXml, 'META-INF/container.xml') as {
    container?: { rootfiles?: { rootfile?: unknown } };
  };
  const rootfiles = asArray(container.container?.rootfiles?.rootfile);
  const rootfile = rootfiles[0] as Record<string, unknown> | undefined;
  const opfPath = rootfile ? String(rootfile['@_full-path'] ?? '') : '';
  if (!opfPath) throw new ApiError('OPF_MISSING', 'container.xml 未声明 rootfile');

  const opfXml = await readEntry(zip, opfPath);
  if (opfXml === null) throw new ApiError('OPF_MISSING', `OPF 文件不存在: ${opfPath}`, 400);
  const opf = parseXml(opfXml, opfPath) as { package?: Record<string, unknown> };
  const pkg = opf.package ?? {};
  const metadata = (pkg.metadata ?? {}) as Record<string, unknown>;
  const title = textOf(metadata.title);
  const author = textOf(metadata.creator);
  const language = textOf(metadata.language);

  const opfDir = dirOf(opfPath);
  const manifestItems = asArray(
    ((pkg.manifest ?? {}) as Record<string, unknown>).item,
  ) as Record<string, unknown>[];
  const manifest: ManifestItem[] = [];
  const seenIds = new Set<string>();
  for (const it of manifestItems) {
    const id = String(it['@_id'] ?? '');
    const href = String(it['@_href'] ?? '');
    const mediaType = String(it['@_media-type'] ?? '');
    const properties = String(it['@_properties'] ?? '').split(/\s+/).filter(Boolean);
    if (seenIds.has(id)) {
      add('DUPLICATE_ITEM_ID', 'error', `manifest 中存在重复的资源 ID: ${id}`, opfPath, id);
    }
    seenIds.add(id);
    manifest.push({ id, href, mediaType, properties });
  }

  const byId = new Map(manifest.map((m) => [m.id, m]));
  const spineRaw = asArray(((pkg.spine ?? {}) as Record<string, unknown>).itemref) as Record<string, unknown>[];
  const spine = spineRaw.map((ir) => {
    const idref = String(ir['@_idref'] ?? '');
    const item = byId.get(idref);
    if (!item) {
      add('SPINE_IDREF_MISSING', 'error', `spine 引用了不存在的 manifest ID: ${idref}`, opfPath, idref);
    }
    return { idref, href: item ? item.href : null };
  });

  // manifest 资源存在性与路径越界
  for (const m of manifest) {
    if (isRemote(m.href)) {
      add('REMOTE_RESOURCE', 'info', `manifest 声明了远程资源（未访问）: ${m.href}`, opfPath, m.href);
      continue;
    }
    const resolved = resolvePackagePath(opfDir, m.href);
    if (resolved === null) {
      add('PATH_TRAVERSAL', 'error', `资源路径越出包根目录: ${m.href}`, opfPath, m.href);
      continue;
    }
    if (!zip.file(resolved)) {
      add('RESOURCE_MISSING', 'error', `manifest 声明的资源缺失: ${m.href}（解析为 ${resolved}）`, resolved, m.href);
    }
  }

  // 导航文档
  const navItem = manifest.find((m) => m.properties.includes('nav'));
  let navPath: string | null = null;
  let navTree: NavNode[] = [];
  if (navItem) {
    navPath = resolvePackagePath(opfDir, navItem.href);
    if (navPath === null) {
      add('PATH_TRAVERSAL', 'error', `导航文档路径越界: ${navItem.href}`, opfPath, navItem.href);
    } else {
      const navXml = await readEntry(zip, navPath);
      if (navXml === null) {
        add('NAV_MISSING', 'error', `声明的导航文档不存在: ${navItem.href}`, navPath, navItem.href);
      } else {
        try {
          const doc = navParser.parse(navXml) as OrderedNode[];
          const lis = findNavList(doc) ?? [];
          navTree = lis.map(liToNavNode);
        } catch {
          add('NAV_PARSE', 'error', `导航文档 XML 解析失败: ${navPath}`, navPath, null);
        }
      }
    }
  }

  // 导航链接检查
  const navDir = navPath ? dirOf(navPath) : '';
  for (const node of flattenNav(navTree)) {
    if (!node.href) continue;
    const href = node.href;
    if (isRemote(href)) {
      add('REMOTE_LINK', 'info', `导航包含远程链接（未访问）: ${href}`, navPath, href);
      continue;
    }
    const [filePart, frag] = href.split('#');
    const target = resolvePackagePath(navDir, filePart || (navPath ?? ''));
    if (target === null) {
      add('PATH_TRAVERSAL', 'error', `导航链接路径越界: ${href}`, navPath, href);
      continue;
    }
    const targetXml = await readEntry(zip, target);
    if (targetXml === null) {
      add('NAV_LINK_TARGET_MISSING', 'error', `导航链接目标文件不存在: ${href}（解析为 ${target}）`, navPath, href);
      continue;
    }
    if (frag) {
      const ids = collectIds(targetXml);
      if (!ids.has(frag)) {
        add('NAV_ANCHOR_MISSING', 'error', `导航链接锚点 #${frag} 在 ${target} 中不存在`, target, href);
      }
    }
  }

  return { opfPath, title, author, language, manifest, spine, navPath, navTree, issues };
}



import AdmZip from 'adm-zip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import path from 'node:path';
import { AppError } from './errors';

export interface ManifestItem {
  id: string;
  href: string;          // 相对 OPF 的原始 href
  resolvedPath: string;  // 以包根为基准的规范化路径
  mediaType: string;
  properties: string;
}
export interface SpineItem { idref: string; linear: boolean }
export interface NavNode {
  label: string;
  href: string;          // 原始 href（可能含 #fragment）
  children: NavNode[];
}
export interface EpubPackage {
  filePath: string;
  entries: Map<string, Buffer>;   // 规范化包内路径 -> 内容
  opfPath: string;
  opfDir: string;                 // OPF 所在目录（'' 表示根）
  title: string;
  creator: string;
  language: string;
  manifest: ManifestItem[];
  duplicateManifestIds: string[];
  spine: SpineItem[];
  navPath: string | null;         // 声明的 nav 文档包内路径
  navTree: NavNode[];
  navParseError: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
});

export function parseXml(xml: string, filePath: string): any {
  const valid = XMLValidator.validate(xml);
  if (valid !== true) {
    throw new AppError('XML_PARSE_ERROR', `XML 解析失败: ${filePath}: ${valid.err.msg}`, 400, valid.err);
  }
  return parser.parse(xml);
}

/** 以 baseFile 所在目录为基准解析相对路径，规范化并拒绝越界 */
export function resolvePath(baseFile: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  const baseDir = path.posix.dirname(baseFile.replace(/\\/g, '/'));
  const joined = path.posix.normalize(path.posix.join(baseDir, clean.replace(/\\/g, '/')));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) {
    throw new AppError('PATH_TRAVERSAL', `包路径越界: ${href} (引用自 ${baseFile})`);
  }
  return joined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: any): string {
  if (node === undefined || node === null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return String(node['#text'] ?? '');
}

/** 解析 nav XHTML 中的 toc 目录树 */
export function parseNavTree(xml: string): NavNode[] {
  const doc = parseXml(xml, 'nav');
  const html = doc.html ?? doc;
  const body = html.body ?? html;
  const navs = asArray<any>(body.nav);
  let tocNav: any = navs.find((n: any) => String(n['@_type'] ?? '').split(/\s+/).includes('toc'));
  if (!tocNav && navs.length > 0) tocNav = navs[0];
  if (!tocNav) return [];
  const ol = asArray<any>(tocNav.ol)[0];
  return ol ? parseOl(ol) : [];
}

function parseOl(ol: any): NavNode[] {
  return asArray<any>(ol.li).map((li: any) => {
    const a = asArray<any>(li.a)[0];
    const span = asArray<any>(li.span)[0];
    const label = textOf(a) || textOf(span);
    const href = a ? String(a['@_href'] ?? '') : '';
    const childOl = asArray<any>(li.ol)[0];
    return { label, href, children: childOl ? parseOl(childOl) : [] };
  });
}

/** 收集 XHTML 中所有 id 属性（容错：用正则，即使文件其它部分损坏也能取到） */
export function collectIds(xml: string): Set<string> {
  const ids = new Set<string>();
  const re = /\bid\s*=\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) ids.add(m[1]);
  return ids;
}

export function openEpub(filePath: string): EpubPackage {
  let zip: AdmZip;
  try {
    zip = new AdmZip(filePath);
  } catch (e) {
    throw new AppError('ZIP_INVALID', `无法解析 ZIP/EPUB 文件: ${filePath}`);
  }
  const entries = new Map<string, Buffer>();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = path.posix.normalize(e.entryName.replace(/\\/g, '/'));
    if (name === '..' || name.startsWith('../') || path.posix.isAbsolute(name)) {
      throw new AppError('PATH_TRAVERSAL', `ZIP 内含越界路径条目: ${e.entryName}`);
    }
    entries.set(name, e.getData());
  }

  const containerBuf = entries.get('META-INF/container.xml');
  if (!containerBuf) throw new AppError('CONTAINER_MISSING', '缺少 META-INF/container.xml');
  let container: any;
  try {
    container = parseXml(containerBuf.toString('utf8'), 'META-INF/container.xml');
  } catch (e) {
    if (e instanceof AppError) throw new AppError('CONTAINER_PARSE_ERROR', e.message);
    throw e;
  }
  const rootfiles = asArray<any>(container?.container?.rootfiles?.rootfile);
  const opfPathRaw = rootfiles[0]?.['@_full-path'];
  if (!opfPathRaw) throw new AppError('OPF_NOT_FOUND', 'container.xml 中未声明 rootfile');
  const opfPath = path.posix.normalize(String(opfPathRaw));
  const opfBuf = entries.get(opfPath);
  if (!opfBuf) throw new AppError('OPF_NOT_FOUND', `OPF 文件不存在于包内: ${opfPath}`);

  let opf: any;
  try {
    opf = parseXml(opfBuf.toString('utf8'), opfPath);
  } catch (e) {
    if (e instanceof AppError) throw new AppError('OPF_PARSE_ERROR', e.message);
    throw e;
  }
  const pkg = opf.package ?? {};
  const meta = pkg.metadata ?? {};
  const title = textOf(asArray<any>(meta.title)[0]) || '(无标题)';
  const creator = textOf(asArray<any>(meta.creator)[0]);
  const language = textOf(asArray<any>(meta.language)[0]);
  const opfDir = path.posix.dirname(opfPath) === '.' ? '' : path.posix.dirname(opfPath);

  const seen = new Set<string>();
  const duplicateManifestIds: string[] = [];
  const manifest: ManifestItem[] = asArray<any>(pkg.manifest?.item).map((it: any) => {
    const id = String(it['@_id'] ?? '');
    if (seen.has(id)) duplicateManifestIds.push(id);
    seen.add(id);
    const href = String(it['@_href'] ?? '');
    return {
      id,
      href,
      resolvedPath: resolvePath(opfPath, href),
      mediaType: String(it['@_media-type'] ?? ''),
      properties: String(it['@_properties'] ?? ''),
    };
  });

  const spine: SpineItem[] = asArray<any>(pkg.spine?.itemref).map((it: any) => ({
    idref: String(it['@_idref'] ?? ''),
    linear: String(it['@_linear'] ?? 'yes') !== 'no',
  }));

  const navItem = manifest.find((m) => m.properties.split(/\s+/).includes('nav'));
  let navTree: NavNode[] = [];
  let navParseError: string | null = null;
  if (navItem && entries.has(navItem.resolvedPath)) {
    try {
      navTree = parseNavTree(entries.get(navItem.resolvedPath)!.toString('utf8'));
    } catch (e) {
      navParseError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    filePath, entries, opfPath, opfDir, title, creator, language,
    manifest, duplicateManifestIds, spine,
    navPath: navItem ? navItem.resolvedPath : null,
    navTree, navParseError,
  };
}

/** 章节阅读顺序（spine 顺序，仅保留能解析到 manifest 的项） */
export function chapterList(pkg: EpubPackage) {
  const byId = new Map(pkg.manifest.map((m) => [m.id, m]));
  return pkg.spine.map((s, i) => {
    const item = byId.get(s.idref);
    return {
      index: i,
      idref: s.idref,
      linear: s.linear,
      path: item ? item.resolvedPath : null,
      mediaType: item ? item.mediaType : null,
    };
  });
}

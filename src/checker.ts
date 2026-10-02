import { EpubPackage, NavNode, resolvePath, collectIds } from './epub';

export type Severity = 'error' | 'warning' | 'info';
export interface Issue {
  severity: Severity;
  code: string;
  message: string;
  filePath: string;   // 问题所在的包内路径
  refValue: string;   // 相关引用值（href / idref / id 等）
}

const REMOTE_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function flattenNav(nodes: NavNode[], base: Array<{ label: string; href: string }> = []) {
  const out: Array<{ label: string; href: string }> = [];
  for (const n of nodes) {
    out.push({ label: n.label, href: n.href });
    out.push(...flattenNav(n.children));
  }
  return out;
}

/** 对打开的包执行一致性检查，返回问题列表（不会抛出） */
export function checkPackage(pkg: EpubPackage): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string, filePath = '', refValue = '') =>
    issues.push({ severity, code, message, filePath, refValue });

  // 1. manifest 重复 id
  for (const id of pkg.duplicateManifestIds) {
    add('error', 'DUP_MANIFEST_ID', `manifest 中存在重复的资源 id: ${id}`, pkg.opfPath, id);
  }

  // 2. manifest 引用的资源是否存在
  for (const item of pkg.manifest) {
    if (!pkg.entries.has(item.resolvedPath)) {
      add('error', 'RESOURCE_MISSING',
        `manifest 声明的资源不存在: ${item.href} (id=${item.id})`, pkg.opfPath, item.href);
    }
  }

  // 3. spine 引用不存在的 manifest id
  const manifestIds = new Set(pkg.manifest.map((m) => m.id));
  for (const s of pkg.spine) {
    if (!manifestIds.has(s.idref)) {
      add('error', 'SPINE_IDREF_MISSING', `spine 引用了不存在的 manifest id: ${s.idref}`, pkg.opfPath, s.idref);
    }
  }

  // 4. 导航文档
  if (!pkg.navPath) {
    add('warning', 'NAV_MISSING', '未声明 properties="nav" 的导航文档', pkg.opfPath, '');
  } else if (!pkg.entries.has(pkg.navPath)) {
    add('error', 'NAV_NOT_FOUND', `声明的导航文档不存在: ${pkg.navPath}`, pkg.opfPath, pkg.navPath);
  } else if (pkg.navParseError) {
    add('error', 'NAV_PARSE_ERROR', `导航文档解析失败: ${pkg.navParseError}`, pkg.navPath, '');
  } else if (pkg.navTree.length === 0) {
    add('warning', 'NAV_EMPTY', '导航文档中未找到 toc 目录', pkg.navPath, '');
  }

  // 5. 导航链接：先核对目标文件，再核对锚点；远程链接只标注不访问
  const idCache = new Map<string, Set<string>>();
  for (const link of flattenNav(pkg.navTree)) {
    const href = link.href;
    if (!href) {
      add('warning', 'NAV_LINK_EMPTY', `目录项「${link.label}」没有链接`, pkg.navPath ?? '', '');
      continue;
    }
    if (REMOTE_RE.test(href) || href.startsWith('//')) {
      add('info', 'REMOTE_LINK', `目录项「${link.label}」为远程链接（仅标注，不访问）: ${href}`, pkg.navPath ?? '', href);
      continue;
    }
    let targetPath: string;
    try {
      targetPath = resolvePath(pkg.navPath!, href);
    } catch (e: any) {
      add('error', 'PATH_TRAVERSAL', `目录项「${link.label}」链接路径越界: ${href}`, pkg.navPath ?? '', href);
      continue;
    }
    if (!pkg.entries.has(targetPath)) {
      add('error', 'NAV_TARGET_MISSING', `目录项「${link.label}」链接的目标文件不存在: ${href}`, pkg.navPath ?? '', href);
      continue;
    }
    const frag = href.includes('#') ? href.slice(href.indexOf('#') + 1) : '';
    if (frag) {
      let ids = idCache.get(targetPath);
      if (!ids) {
        ids = collectIds(pkg.entries.get(targetPath)!.toString('utf8'));
        idCache.set(targetPath, ids);
      }
      if (!ids.has(frag)) {
        add('error', 'NAV_ANCHOR_MISSING',
          `目录项「${link.label}」链接的锚点 #${frag} 在 ${targetPath} 中不存在`, pkg.navPath ?? '', href);
      }
    }
  }

  return issues;
}

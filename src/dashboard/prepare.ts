import { init, parse } from 'es-module-lexer/js'
import type { DashboardPackage } from '../contracts'

export interface PreparedDashboard { html: string; dispose: () => void }
const virtualRoot = 'https://dashboard.invalid/'
const policy = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src blob:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** Uploaded code only executes inside an opaque sandbox, never in the application document. */
export async function prepareDashboard(pack: DashboardPackage, nonce: string): Promise<PreparedDashboard> {
  await init()
  const files = new Map(pack.files.map(file => [file.path, file]))
  if (!files.has(pack.entry)) throw new Error('看板缺少指定 HTML 入口')
  const urls = new Map<string, string>()
  const created: string[] = []
  const imports: Record<string, string> = Object.create(null)
  const reading = new Set<string>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const bytes = (path: string) => {
    const file = files.get(path)
    if (!file) throw new Error(`看板缺少文件：${path}`)
    const binary = atob(file.base64)
    return Uint8Array.from(binary, c => c.charCodeAt(0))
  }
  const text = (path: string) => decoder.decode(bytes(path))
  function resolve(reference: string, base: string): string {
    if (reference.includes('\\')) throw new Error(`不支持的资源路径：${reference}`)
    const url = new URL(reference, new URL(base, virtualRoot))
    if (url.origin !== new URL(virtualRoot).origin || url.username || url.password) throw new Error(`看板预览禁止外部资源：${reference}`)
    const path = decodeURIComponent(url.pathname.slice(1))
    if (!files.has(path)) throw new Error(`看板缺少文件：${path}（引用自 ${base}）`)
    return path
  }
  function objectUrl(content: BlobPart, mime: string): string {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    created.push(url)
    return url
  }
  function script(source: string, base: string): string {
    const [references] = parse(source)
    const edits: { start: number; end: number; value: string }[] = []
    for (const reference of references) {
      if (reference.type === 'import-meta') {
        const tail = source.slice(reference.end)
        if (!tail.startsWith('.url')) throw new Error(`不支持的 import.meta 用法：${base}`)
        edits.push({ start: reference.start, end: reference.end + 4, value: JSON.stringify(new URL(base, virtualRoot).href) })
        continue
      }
      if (!reference.specifier || (reference.type === 'dynamic' && reference.glob)) throw new Error(`动态模块路径必须为固定字符串：${base}`)
      if (!reference.specifier.startsWith('.') && !reference.specifier.startsWith('/')) throw new Error(`请将模块依赖打包为本地相对路径：${reference.specifier}`)
      const dependency = resolve(reference.specifier, base)
      if (!/\.(?:m?js|cjs)$/i.test(dependency)) throw new Error(`请先构建工程，再上传浏览器可运行的 JavaScript：${dependency}`)
      const virtual = new URL(dependency, virtualRoot).href
      imports[virtual] ??= ''
      compile(dependency, 'script')
      edits.push({ start: reference.start, end: reference.end, value: reference.type === 'dynamic' ? JSON.stringify(virtual) : virtual })
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.value + source.slice(edit.end)
    return source
  }
  function css(source: string, base: string): string {
    const replaced = source.replace(/@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi, (_all, _quote: string, reference: string) => `@import url(${JSON.stringify(resource(reference, base, 'style'))})`)
    return replaced.replace(/url\(\s*(?:(["'])(.*?)\1|([^\s)'"(]+))\s*\)/gi, (_all, _quote: string, quoted: string, bare: string) => {
      const value = quoted ?? bare
      if (value.startsWith('blob:') || value.startsWith('data:') || value.startsWith('#')) return `url(${JSON.stringify(value)})`
      return `url(${JSON.stringify(resource(value, base))})`
    })
  }
  function compile(path: string, purpose?: 'script' | 'style'): string {
    const existing = urls.get(path)
    if (existing) return existing
    if (reading.has(path)) {
      if (purpose === 'script') return new URL(path, virtualRoot).href
      throw new Error(`CSS 资源循环引用：${path}`)
    }
    reading.add(path)
    try {
      const file = files.get(path)!
      if (/\.(?:ts|tsx|vue|jsx)$/i.test(path) && purpose === 'script') throw new Error(`请先构建源码并选择 dist/build HTML 入口：${path}`)
      const url = purpose === 'script' ? objectUrl(script(text(path), path), 'text/javascript') : purpose === 'style' || /\.css$/i.test(path) ? objectUrl(css(text(path), path), 'text/css') : objectUrl(bytes(path), file.mime)
      urls.set(path, url)
      if (purpose === 'script') imports[new URL(path, virtualRoot).href] = url
      return url
    } finally { reading.delete(path) }
  }
  function resource(reference: string, base: string, purpose?: 'script' | 'style'): string {
    if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return reference
    return compile(resolve(reference, base), purpose)
  }
  const dispose = () => { for (const url of created) URL.revokeObjectURL(url) }
  try {
    const document = new DOMParser().parseFromString(text(pack.entry), 'text/html')
    if (document.querySelector('iframe,frame,object,embed,portal')) throw new Error('看板预览不支持嵌套页面或插件')
    if (document.querySelector('script[type="importmap"]')) throw new Error('不支持自定义 importmap，请先将依赖打包到本地')
    document.querySelectorAll('base,meta[http-equiv]').forEach(element => element.remove())
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of ['action', 'formaction', 'ping', 'target']) element.removeAttribute(attribute)
      if (element.hasAttribute('style')) element.setAttribute('style', css(element.getAttribute('style')!, pack.entry))
      if (element.tagName === 'STYLE') element.textContent = css(element.textContent || '', pack.entry)
      if (element.tagName === 'SCRIPT') {
        const type = element.getAttribute('type') || ''
        if (type && type !== 'module' && !/^(?:text|application)\/(?:java|ecma)script$/i.test(type)) continue
        element.removeAttribute('integrity'); element.removeAttribute('crossorigin')
        if (element.hasAttribute('src')) element.setAttribute('src', resource(element.getAttribute('src')!, pack.entry, 'script'))
        else element.textContent = script(element.textContent || '', pack.entry)
        continue
      }
      if (element.tagName === 'LINK') {
        const rel = element.getAttribute('rel') || ''
        if (!/stylesheet|icon|preload|modulepreload/i.test(rel)) { element.remove(); continue }
        const purpose = rel === 'stylesheet' ? 'style' : rel === 'modulepreload' ? 'script' : undefined
        if (element.hasAttribute('href')) element.setAttribute('href', resource(element.getAttribute('href')!, pack.entry, purpose))
        element.removeAttribute('integrity'); element.removeAttribute('crossorigin')
      } else {
        for (const name of ['src', 'href', 'poster', 'background', 'xlink:href']) {
          const value = element.getAttribute(name)
          if (value === null) continue
          if ((element.tagName === 'A' || element.tagName === 'AREA') && name === 'href' && !value.startsWith('#')) { element.removeAttribute(name); continue }
          element.setAttribute(name, resource(value, pack.entry))
        }
      }
      for (const name of ['srcset', 'imagesrcset']) {
        const value = element.getAttribute(name)
        if (!value) continue
        if (/data:/i.test(value)) throw new Error('srcset 中请使用包内相对图片路径')
        element.setAttribute(name, value.split(',').map(part => {
          const match = part.trim().match(/^(\S+)(.*)$/)
          return match ? resource(match[1]!, pack.entry) + match[2] : ''
        }).join(', '))
      }
    }
    // Attachments are available as inert bytes; compile only dependencies reached by the HTML entry.
    for (const file of pack.files) if (!urls.has(file.path)) urls.set(file.path, objectUrl(bytes(file.path), file.mime))
    const runtimeFiles = Object.fromEntries([...urls].map(([path, url]) => [new URL(path, virtualRoot).href, url]))
    const runtime = `(() => {const files=${safeJson(runtimeFiles)},base=${safeJson(new URL(pack.entry, virtualRoot).href)},nonce=${safeJson(nonce)};const report=message=>parent.postMessage({kind:'dashboard-error',nonce,message:String(message).slice(0,500)},'*');function local(value){const s=String(value);if(/^(blob:|data:|#)/i.test(s))return s;const u=new URL(s,base);const found=files[u.origin+u.pathname];if(!found)throw Error('已阻止外部或缺失资源：'+s);return found+u.hash;}const originalFetch=window.fetch.bind(window);window.fetch=(input,options)=>{try{return originalFetch(local(input instanceof Request?input.url:input),{...options,credentials:'omit'});}catch(e){report(e.message);return Promise.reject(e);}};const set=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){if(/^(src|poster|background|xlink:href)$/i.test(name)){try{value=local(value);}catch(e){report(e.message);return;}}return set.call(this,name,value);};for(const [prototype,key]of [[HTMLImageElement.prototype,'src'],[HTMLScriptElement.prototype,'src'],[HTMLMediaElement.prototype,'src']]){const d=Object.getOwnPropertyDescriptor(prototype,key);if(d?.set)Object.defineProperty(prototype,key,{...d,set(value){try{d.set.call(this,local(value));}catch(e){report(e.message);}}});}addEventListener('error',e=>report(e.message||'模板资源加载失败'),true);addEventListener('unhandledrejection',e=>report(e.reason?.message||'模板脚本执行失败'));addEventListener('securitypolicyviolation',e=>report('隔离策略已阻止：'+e.violatedDirective));})();`
    const csp = document.createElement('meta'); csp.httpEquiv = 'Content-Security-Policy'; csp.content = policy
    const referrer = document.createElement('meta'); referrer.name = 'referrer'; referrer.content = 'no-referrer'
    const bootstrap = document.createElement('script'); bootstrap.textContent = runtime
    const importMap = document.createElement('script'); importMap.type = 'importmap'; importMap.textContent = safeJson({ imports })
    document.head.prepend(csp, referrer, bootstrap, importMap)
    return { html: '<!doctype html>' + document.documentElement.outerHTML, dispose }
  } catch (error) { dispose(); throw error }
}
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

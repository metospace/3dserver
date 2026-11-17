export const appVersion = '1.1.2'
export const releases = [
  { version: '1.1.2', date: '2026-11-17', title: '大模型、缩略图与说明修复', changes: [
    'GLB 上限提高至 512 MB，模型传输与解码允许较长处理时间；看板限制保持不变。',
    '修正 BIN 大于声明缓冲区时的误拦，仍拒绝截断和越界引用。',
    '缺失缩略图支持显式串行补建；详情使用已加载画面截取，失败显示实际原因。',
    '版本说明可单独修改，保留并发冲突保护与原始模型文件。',
  ] },
  { version: '1.1.1', date: '2026-11-17', title: '内网 HTTP 上传兼容修复', changes: [
    '使用 getRandomValues 生成安全随机 UUID，修复普通 HTTP 内网地址下选择文件时报 randomUUID 不可用。',
    '同步修复上传幂等标识、冲突重新提交、截图上传与看板预览标识，不改变版本和重试规则。',
  ] },
  { version: '1.1.0', date: '2026-11-17', title: '团队资源库与设置', changes: [
    '固定资产、场景、看板三类库，移除项目并迁移保留已有文件与版本。',
    '分类移至主内容区筛选，选中一级分类后展开子分类；各库独立管理。',
    '增加单调修订号冲突保护、持久上传幂等和全局角色权限。',
    '新增 HTML、ZIP、文件夹看板管理、固定版本截图和隔离运行预览。',
    '支持浅色、深色、跟随系统；卡片缩略图等比铺满预览区。',
    '新增设置页、浏览偏好、部署信息及已部署版本检查。',
    '系统名称统一为 Scenivo，登录页、侧栏、关于页面和浏览器图标使用指定蓝色标志。',
    '精简权限标记、库页副标题及设置辅助文案，保留错误、进度、文件限制和安全提醒。',
  ] },
  { version: '1.0.0', date: '2026-11-17', title: '初始模型管理平台', changes: [
    '支持 GLB 批量上传、三维预览、动画播放、历史版本和原文件下载。',
    '提供账号登录、SQLite 与磁盘存储，以及内网部署配置。',
  ] },
] as const

export interface SystemInfo {
  version: string
  databaseVersion: number
  role: string
  limits: { modelMB: number; screenshotMB: number; dashboardMB: number; expandedMB: number; dashboardFiles: number }
  records: { asset: number; scene: number; dashboard: number }
  versionCount: number
  sourceBytes: number
  dataDirectory?: string
  runtime?: string
}

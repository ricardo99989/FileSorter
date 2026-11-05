'use strict';

/**
 * describe.js — 文件智能说明引擎
 *
 * 设计取舍：这里刻意不调用在线大模型。
 *  - 文件说明是高频、低价值密度的信息，一次目录里可能有上千条，联网必然是灾难；
 *  - 扩展名到用途的映射是确定知识，用本地知识库比模型更准、更快、可测试；
 *  - 真正的"智能"体现在结合文件名、体积、时间做语境推断（截图 / 微信保存 / 安装包 / 未完成下载）。
 *
 * 输出契约：
 *   summarize(entry) -> { label, category, brief }   // 列表用，一句话
 *   detailOf(entry)  -> { label, category, brief, detail, hints, tips } // 详情栏用
 */

const CATEGORIES = {
  folder: '文件夹',
  image: '图片',
  video: '视频',
  audio: '音频',
  doc: '文档',
  sheet: '表格',
  slide: '演示',
  code: '代码',
  archive: '压缩包',
  app: '程序',
  font: '字体',
  data: '数据',
  design: '设计',
  model: '三维',
  other: '其他',
};

/** @type {Record<string, {label:string, cat:string, brief:string, extra?:string}>} */
const TYPES = Object.create(null);

/**
 * 批量登记扩展名，避免一百多行重复对象字面量。
 * @param {string[]} exts
 * @param {string} label 面向普通人的类型名
 * @param {string} cat 分类键
 * @param {string} brief 一句话说明（列表展示）
 * @param {string} [extra] 详情栏补充
 */
function def(exts, label, cat, brief, extra) {
  for (const ext of exts) {
    TYPES[ext] = { label, cat, brief, extra: extra || '' };
  }
}

/* ------------------------------ 图片 ------------------------------ */
def(['jpg', 'jpeg'], 'JPEG 图片', 'image',
  '最常见的照片格式，手机拍的照片、网页上的图片大多是它。',
  '有损压缩，反复另存会一点点掉画质；要长期保存的图尽量留原图。');
def(['png'], 'PNG 图片', 'image',
  '支持透明背景的图片，截图、图标、界面素材常用它。',
  '无损压缩，体积通常比 JPG 大，适合需要透明边缘的图。');
def(['gif'], 'GIF 动图', 'image',
  '会动的图片，表情包和简单演示常用；颜色数有限。',
  '只有 256 色，不适合放真实照片；要高质量动图可以换 WebP 或视频。');
def(['webp'], 'WebP 图片', 'image',
  '网页专用的轻量图片格式，体积比 JPG 小，也支持透明。',
  'Chrome、Edge、微信都能打开；老版本看图软件可能不认。');
def(['bmp'], 'BMP 位图', 'image',
  '最原始的位图格式，几乎不压缩，所以体积很大。');
def(['tif', 'tiff'], 'TIFF 图片', 'image',
  '印刷和扫描常用的高质量图片格式，体积偏大。',
  '常出现在扫描件、印刷稿件里；普通看图软件可能需要插件。');
def(['heic', 'heif'], 'HEIC 照片', 'image',
  '苹果手机默认的照片格式，体积小画质好。',
  'Windows 需要装「HEIF 图像扩展」才能直接预览，否则会打不开。');
def(['avif'], 'AVIF 图片', 'image',
  '新一代高压缩图片格式，同画质下体积比 JPG 小很多。');
def(['ico'], 'ICO 图标', 'image',
  'Windows 的程序图标文件，一般不用手动打开。');
def(['svg'], 'SVG 矢量图', 'image',
  '用代码描述的形状图，放大不会模糊，图标和 logo 常用。',
  '本质是文本，可以直接用记事本查看源码，也能用浏览器打开。');
def(['psd'], 'Photoshop 源文件', 'design',
  '设计稿的分层原件，用来改图层、调颜色、做美术设计。',
  '只有 Photoshop 或同类软件能完整打开；别人发你 PSD 通常是让你改稿。');
def(['psb'], 'Photoshop 大文件', 'design',
  '超大尺寸的 Photoshop 工程文件，用于海报、展板等大幅面设计。');
def(['ai'], 'Illustrator 矢量源文件', 'design',
  'logo、图标的矢量原件，可以无限放大而不模糊。',
  '用 Illustrator 打开；如果只想看效果，让对方导出一份 PDF 更方便。');
def(['eps'], 'EPS 矢量文件', 'design',
  '印刷行业通用的矢量格式，常用来交付 logo 和包装稿。');
def(['indd'], 'InDesign 排版文件', 'design',
  '书籍、画册的排版源文件，需要 InDesign 打开。');
def(['xd'], 'Adobe XD 原型文件', 'design',
  '界面设计和交互原型的源文件。');
def(['fig'], 'Figma 设计文件', 'design',
  'Figma 的本地设计文件，导入网页版后可以继续编辑。');
def(['sketch'], 'Sketch 设计文件', 'design',
  'macOS 上的界面设计源文件。');
def(['afdesign', 'afphoto'], 'Affinity 设计文件', 'design',
  'Affinity 系列软件的设计源文件，可替代 Photoshop / Illustrator。');
def(['raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2'], '相机 RAW 原片', 'image',
  '相机直接输出的未处理照片，后期调整空间最大。',
  '体积通常是 JPG 的 3~5 倍，需要 Lightroom 或相机自带软件处理。');
def(['exr', 'hdr'], '高动态范围图像', 'image',
  '用于影视和三维渲染的高动态范围图，普通看图软件会显示发灰。');

/* ------------------------------ 视频 ------------------------------ */
def(['mp4', 'm4v'], 'MP4 视频', 'video',
  '最常见的视频格式，手机、电脑、网页都能直接播放。');
def(['mkv'], 'MKV 视频', 'video',
  '高清影视常用的封装格式，能同时装多条音轨和字幕。',
  '播放器支持很好；剪辑软件可能需要先转码。');
def(['mov'], 'QuickTime 视频', 'video',
  '苹果设备录制的视频格式，剪辑软件普遍支持。');
def(['avi'], 'AVI 视频', 'video',
  '比较早期的视频格式，兼容性好但文件偏大。');
def(['wmv'], 'WMV 视频', 'video',
  'Windows 早期常用的视频格式，现在多为历史资料。');
def(['flv'], 'FLV 视频', 'video',
  '早期网页视频（Flash）用的格式，需要专门播放器。');
def(['webm'], 'WebM 视频', 'video',
  '网页开源视频格式，体积小，浏览器直接支持。');
def(['mts', 'm2ts'], '摄像机视频', 'video',
  '摄像机录制的原始视频，码率高、体积大。');
def(['mpg', 'mpeg', 'vob'], 'MPEG 视频', 'video',
  '老式光盘和电视录制常用的视频格式。');
def(['3gp'], '3GP 视频', 'video',
  '早期功能机拍摄的低分辨率视频。');
def(['ts'], 'TS 视频流', 'video',
  '电视录制和网络直播常见的视频流格式。');
def(['srt', 'ass', 'ssa', 'vtt'], '字幕文件', 'doc',
  '视频的外挂字幕，和视频同名放在一起就能自动加载。');
def(['prproj'], 'Premiere 剪辑工程', 'video',
  'Premiere 的剪辑工程文件，记录了时间线和素材引用。');
def(['aep'], 'After Effects 工程', 'video',
  '特效合成工程文件，依赖插件和素材才能正常打开。');

/* ------------------------------ 音频 ------------------------------ */
def(['mp3'], 'MP3 音频', 'audio',
  '最通用的音乐格式，几乎所有设备都能播放。');
def(['wav'], 'WAV 音频', 'audio',
  '未压缩的原始音频，录音和剪辑常用，体积很大。');
def(['flac'], 'FLAC 无损音频', 'audio',
  '无损压缩的音乐，音质等同 CD，体积约为 MP3 的五倍。');
def(['aac', 'm4a'], 'AAC 音频', 'audio',
  '苹果和流媒体常用的音频格式，同码率下比 MP3 好听。');
def(['ogg', 'opus'], 'Ogg 音频', 'audio',
  '开源音频格式，语音和网页播放常用。');
def(['wma'], 'WMA 音频', 'audio',
  'Windows 早期的音频格式。');
def(['aiff'], 'AIFF 音频', 'audio',
  '苹果系统的无损音频格式，专业录音常用。');
def(['ape'], 'APE 无损音频', 'audio',
  '高压缩率的无损音乐格式，多见于无损音乐收藏。');
def(['mid', 'midi'], 'MIDI 音乐', 'audio',
  '只记录音符和乐器指令，不含真实声音，需要音源才能播放。');
def(['cda'], 'CD 音轨', 'audio',
  '音乐光盘上的音轨索引，单独拷出来无法播放。');

/* ------------------------------ 文档 ------------------------------ */
def(['pdf'], 'PDF 文档', 'doc',
  '版式固定的文档，任何设备打开都不会串版，合同和说明书常用。',
  '可以直接阅读和打印；要修改文字需要专门的 PDF 编辑工具。');
def(['docx'], 'Word 文档', 'doc',
  '可编辑的文字文档，写报告、合同、方案的标准格式。');
def(['doc'], 'Word 97-2003 文档', 'doc',
  '老版本 Word 格式，新软件能打开，但排版可能轻微偏移。');
def(['txt'], '纯文本文件', 'doc',
  '只有文字、没有任何格式，用记事本就能打开。');
def(['md', 'markdown'], 'Markdown 文档', 'doc',
  '用简单符号排版的纯文本，写笔记和项目说明常用。',
  '用记事本能看到原始符号，用 Typora、VS Code 等工具才会渲染成排版效果。');
def(['rtf'], 'RTF 富文本文档', 'doc',
  '带基础格式的文档，跨软件兼容性比 Word 好。');
def(['odt'], 'OpenDocument 文档', 'doc',
  '开源办公软件（WPS、LibreOffice）的文档格式。');
def(['wps'], 'WPS 文档', 'doc',
  'WPS 的文字文档，用 WPS 或 Word 都能打开。');
def(['pages'], 'Pages 文档', 'doc',
  '苹果办公软件的文档，Windows 上需要导出成 Word 或 PDF。');
def(['tex'], 'LaTeX 源文件', 'doc',
  '学术论文的排版源码，需要编译后才能生成 PDF。');
def(['epub'], 'EPUB 电子书', 'doc',
  '最通用的电子书格式，手机阅读器、Kindle 之外基本都支持。');
def(['mobi'], 'Mobi 电子书', 'doc',
  '亚马逊 Kindle 早期使用的电子书格式。');
def(['azw3'], 'Kindle 电子书', 'doc',
  'Kindle 专用格式，需要 Kindle 设备或 App 打开。');
def(['chm'], 'CHM 帮助文档', 'doc',
  'Windows 早期的帮助手册格式，常见于软件说明书。');

/* ------------------------------ 表格 ------------------------------ */
def(['xlsx'], 'Excel 工作簿', 'sheet',
  '表格文件，用来记账、统计和分析数据，支持公式和图表。');
def(['xls'], 'Excel 97-2003 工作簿', 'sheet',
  '老版本 Excel 格式，新版本能打开但部分新功能会丢失。');
def(['csv'], 'CSV 表格', 'sheet',
  '用逗号分隔的纯文本表格，几乎所有表格软件和数据库都能导入。',
  '本质是文本，用记事本也能看；含逗号的单元格需要引号包裹。');
def(['tsv'], 'TSV 表格', 'sheet',
  '用制表符分隔的纯文本表格，常见于数据导出。');
def(['ods'], 'OpenDocument 表格', 'sheet',
  '开源办公软件的表格格式。');
def(['numbers'], 'Numbers 表格', 'sheet',
  '苹果办公软件的表格，Windows 上需要先导出。');
def(['et'], 'WPS 表格', 'sheet',
  'WPS 的表格文件，用 Excel 也能打开。');

/* ------------------------------ 演示 ------------------------------ */
def(['pptx'], 'PowerPoint 演示文稿', 'slide',
  '幻灯片文件，用来做汇报、培训和提案。');
def(['ppt'], 'PowerPoint 97-2003 演示文稿', 'slide',
  '老版本幻灯片格式，新版能打开，动画效果可能有偏差。');
def(['key'], 'Keynote 演示文稿', 'slide',
  '苹果办公软件的幻灯片，Windows 上建议先导出成 PPT 或 PDF。');
def(['odp'], 'OpenDocument 演示文稿', 'slide',
  '开源办公软件的幻灯片格式。');
def(['dps'], 'WPS 演示文稿', 'slide',
  'WPS 的幻灯片文件。');

/* ------------------------------ 代码 ------------------------------ */
def(['js', 'mjs', 'cjs'], 'JavaScript 脚本', 'code',
  '网页和 Node.js 的源代码，双击不会运行，需要用工具或浏览器加载。');
def(['ts', 'tsx'], 'TypeScript 源码', 'code',
  '带类型标注的 JavaScript，需要编译后才能在浏览器运行。');
def(['jsx'], 'React 组件', 'code',
  'React 的界面组件源码，需要构建工具打包。');
def(['vue'], 'Vue 组件', 'code',
  'Vue 框架的单文件组件，包含结构、样式和逻辑。');
def(['py'], 'Python 脚本', 'code',
  'Python 源代码，需要装好 Python 环境才能运行。');
def(['ipynb'], 'Jupyter 笔记本', 'code',
  '能同时保存代码、运行结果和图表的交互式笔记，数据分析常用。');
def(['java'], 'Java 源码', 'code',
  'Java 源代码，需要编译成 class 文件才能运行。');
def(['jar'], 'Java 归档包', 'code',
  '打包好的 Java 程序或类库，需要 Java 环境运行。');
def(['c'], 'C 源码', 'code',
  'C 语言源代码，需要编译器编译成可执行文件。');
def(['cpp', 'cc', 'cxx'], 'C++ 源码', 'code',
  'C++ 源代码，需要编译器编译后才能运行。');
def(['h', 'hpp'], 'C/C++ 头文件', 'code',
  '声明函数和数据结构的头文件，被源码引用，不单独运行。');
def(['cs'], 'C# 源码', 'code',
  'C# 源代码，通常配合 .NET 使用。');
def(['go'], 'Go 源码', 'code',
  'Go 语言源代码，编译后是单个可执行文件。');
def(['rs'], 'Rust 源码', 'code',
  'Rust 语言源代码，需要 cargo 编译。');
def(['rb'], 'Ruby 源码', 'code',
  'Ruby 源代码，常见于 Web 后端脚本。');
def(['php'], 'PHP 源码', 'code',
  'PHP 网页脚本，需要 Web 服务器解析后才会执行。');
def(['swift'], 'Swift 源码', 'code',
  '苹果平台的开发语言源码。');
def(['kt', 'kts'], 'Kotlin 源码', 'code',
  'Kotlin 源代码，安卓开发常用。');
def(['sh'], 'Shell 脚本', 'code',
  'Linux / macOS 的命令脚本，Windows 上需要 Git Bash 或 WSL。');
def(['bat', 'cmd'], '批处理脚本', 'code',
  '一串 Windows 命令，双击会依次执行；来源不明时不要运行。',
  '右键「编辑」可以先用记事本看清它到底做了什么。');
def(['ps1'], 'PowerShell 脚本', 'code',
  'Windows 自动化脚本，默认可能被策略拦住而不允许运行。');
def(['sql'], 'SQL 脚本', 'code',
  '数据库查询或建表语句，需要用数据库工具执行。');
def(['html', 'htm'], '网页文件', 'code',
  '网页的结构文件，双击会用浏览器打开。');
def(['css'], '样式表', 'code',
  '控制网页外观的文件，配合 HTML 使用。');
def(['scss', 'sass', 'less'], 'CSS 预处理器文件', 'code',
  '带变量和嵌套语法的样式源码，需要编译成普通 CSS。');
def(['json'], 'JSON 数据文件', 'data',
  '用键值对存数据的文本文件，程序之间传数据常用。');
def(['yaml', 'yml'], 'YAML 配置', 'data',
  '靠缩进表达层级的配置文件，Docker、CI 流程常用。');
def(['xml'], 'XML 数据文件', 'data',
  '用标签描述结构的文本文件，老系统和 Office 文档内部常用。');
def(['toml'], 'TOML 配置', 'data',
  '结构清晰的配置文件，Rust、Python 项目常用。');
def(['ini', 'cfg', 'conf'], '配置文件', 'data',
  '保存软件设置的文本文件，改之前建议先备份。');
def(['env'], '环境变量文件', 'data',
  '存放密钥、账号等运行参数，不要上传到公开仓库。');
def(['log'], '日志文件', 'data',
  '软件运行过程记录，排查问题时才需要看。');
def(['lock'], '依赖锁定文件', 'data',
  '记录依赖的精确版本，保证不同机器装出一致环境，不要手改。');

/* ------------------------------ 压缩包 ------------------------------ */
def(['zip'], 'ZIP 压缩包', 'archive',
  '打包压缩的文件，Windows 可直接双击查看，解压后才能正常使用。');
def(['rar'], 'RAR 压缩包', 'archive',
  '压缩率较高的压缩包，Windows 需要装 7-Zip 或 WinRAR 才能解压。');
def(['7z'], '7Z 压缩包', 'archive',
  '压缩率很高的格式，需要 7-Zip 解压。');
def(['tar'], 'TAR 归档包', 'archive',
  '把多个文件打成一个包，通常不压缩，Linux 环境常见。');
def(['gz', 'tgz'], 'GZIP 压缩文件', 'archive',
  'Linux 常用的压缩格式，常和 tar 一起出现。');
def(['bz2', 'xz'], '高压缩率归档', 'archive',
  'Linux 上的压缩格式，压缩率高但速度慢。');
def(['iso'], '光盘镜像', 'archive',
  '整张光盘打包成一个文件，Win10 之后可直接双击挂载成虚拟光驱。');
def(['dmg'], 'macOS 磁盘映像', 'archive',
  '苹果系统的安装镜像，Windows 上无法直接使用。');

/* ------------------------------ 程序 ------------------------------ */
def(['exe'], 'Windows 程序', 'app',
  '双击可以安装或启动软件；来源不明的 exe 不要运行。',
  '收到别人发来的 exe 时，先确认来源；杀毒软件报毒不要强行放行。');
def(['msi'], 'Windows 安装包', 'app',
  '微软标准安装包，双击进入安装向导，适合批量部署。');
def(['msix', 'appx'], 'Windows 应用包', 'app',
  '微软商店应用的安装包格式。');
def(['lnk'], '快捷方式', 'app',
  '指向另一个文件或程序的链接，删掉它不会删原文件。');
def(['dll'], '动态链接库', 'app',
  '程序运行时依赖的组件，不能直接打开，也不要随手删除。');
def(['sys'], '系统驱动文件', 'app',
  'Windows 驱动或系统组件，普通用户不需要动它。');
def(['apk'], '安卓安装包', 'app',
  '安卓应用的安装文件，需要在手机上安装。');
def(['deb', 'rpm'], 'Linux 安装包', 'app',
  'Linux 系统的软件包，用包管理器安装。');
def(['appimage'], 'Linux 便携程序', 'app',
  '免安装的 Linux 可执行程序。');
def(['crx'], '浏览器扩展', 'app',
  'Chrome 或 Edge 的插件安装包。');
def(['ttf', 'otf'], '字体文件', 'font',
  '安装后可以在文档和设计软件里选用这种字体。',
  '双击可预览，点「安装」后 Word、PS 里就能选到它。');
def(['woff', 'woff2'], '网页字体', 'font',
  '网页专用的压缩字体，体积比 ttf 小。');
def(['fon'], '系统字体', 'font',
  'Windows 早期的点阵字体文件。');

/* ------------------------------ 数据 ------------------------------ */
def(['db', 'sqlite', 'sqlite3'], 'SQLite 数据库', 'data',
  '单文件数据库，很多桌面软件用它存数据，需要数据库工具打开。');
def(['mdb', 'accdb'], 'Access 数据库', 'data',
  '微软 Access 的数据库文件，办公场景的小型数据管理常用。');
def(['dat', 'bin'], '二进制数据文件', 'data',
  '给程序读取的二进制数据，通常不能直接打开。');
def(['pak', 'arc'], '游戏资源包', 'data',
  '游戏打包后的资源文件，需要专用工具解包。');
def(['sav', 'save'], '游戏存档', 'data',
  '游戏进度存档，拷到同版本游戏目录下可以继续玩。');
def(['pem', 'crt', 'cer', 'pfx'], '证书文件', 'data',
  '用于加密和身份验证，属于敏感文件，不要随意外发。');
def(['torrent'], 'BT 种子', 'data',
  '下载链接的索引文件，需要 BT 客户端打开。');

/* ------------------------------ 三维 ------------------------------ */
def(['obj'], 'OBJ 三维模型', 'model',
  '通用的三维模型格式，只存几何形状，材质要配套文件。');
def(['fbx'], 'FBX 三维模型', 'model',
  '带骨骼和动画的三维模型，游戏和影视流程常用。');
def(['stl'], 'STL 三维模型', 'model',
  '3D 打印最常用的格式，只描述表面形状。');
def(['gltf', 'glb'], 'glTF 三维模型', 'model',
  '网页三维展示常用的轻量模型格式，glb 是它的单文件版。');
def(['blend'], 'Blender 工程', 'model',
  'Blender 的场景源文件，包含模型、材质和灯光。');
def(['max'], '3ds Max 工程', 'model',
  '3ds Max 的场景源文件，需要对应版本或更高版本打开。');
def(['ma', 'mb'], 'Maya 工程', 'model',
  'Maya 的场景源文件。');
def(['c4d'], 'Cinema 4D 工程', 'model',
  'C4D 的场景源文件，做动态图形常用。');
def(['step', 'stp', 'iges', 'igs'], '工程 CAD 模型', 'model',
  '机械设计通用的三维交换格式，精度高但体积大。');
def(['dwg', 'dxf'], 'CAD 图纸', 'model',
  '工程制图的源文件，需要 CAD 软件打开。');

/* ------------------------------ 兜底 ------------------------------ */

const UNKNOWN_LABEL = '其他文件';

/** 未知扩展名时，用长度和字符特征给一个保守判断 */
function fallbackByExt(ext) {
  if (!ext) return { label: '无扩展名文件', cat: 'other', brief: '没有扩展名，系统无法判断类型，可能由专用软件生成。', extra: '' };
  if (ext.length > 5) {
    return { label: '专用格式文件', cat: 'other', brief: `扩展名 .${ext} 不常见，可能属于某个专业软件。`, extra: '不确定来源时先别双击，可以右键查看属性或用文本编辑器看看文件头。' };
  }
  return { label: `${ext.toUpperCase()} 文件`, cat: 'other', brief: `扩展名为 .${ext}，本机没有登记它的用途。`, extra: '如果是从网上下的，通常需要对应的软件才能打开。' };
}

/* ------------------------------ 语境推断 ------------------------------ */

const RULES = [
  {
    test: /^(~\$|\.~|\._)/,
    tag: '临时锁文件',
    text: '这是打开文档时生成的临时锁文件，正常关闭软件后会自动消失。',
    weight: 100,
  },
  {
    test: /\.(tmp|temp|part|crdownload|download)$/i,
    tag: '未完成',
    text: '看起来是任务中断留下的临时文件，下载或保存没有走完。',
    weight: 95,
  },
  {
    test: /^(screenshot|screen shot|snipaste|截图|屏幕截图|捕获)/i,
    tag: '截图',
    text: '从名字看是屏幕截图，通常是某个界面或报错的留证。',
    weight: 70,
  },
  {
    test: /^(img|dsc|dscn|pxl|gopr|dji)[-_ ]?\d+/i,
    tag: '拍摄原图',
    text: '命名像相机或手机自动生成的照片，同批文件往往是一次拍摄。',
    weight: 65,
  },
  {
    test: /^(微信图片|微信视频|mmexport|wx_camera|micromsg)/i,
    tag: '微信保存',
    text: '从微信里保存下来的文件，同名副本多时可以按时间清理。',
    weight: 60,
  },
  {
    test: /(setup|installer|install|安装包|安装程序)/i,
    tag: '安装程序',
    text: '这是一份安装程序，装完软件后通常可以删掉以腾出空间。',
    weight: 58,
  },
  {
    test: /(发票|invoice|receipt|报销)/i,
    tag: '票据',
    text: '像是发票或报销凭证，建议按月份归档，别随手删。',
    weight: 55,
  },
  {
    test: /(简历|resume|curriculum)/i,
    tag: '简历',
    text: '简历类文档，投递前注意版本和日期是否是最新的。',
    weight: 54,
  },
  {
    test: /(final|最终|定稿|终版|成品)/i,
    tag: '定稿',
    text: '名字里带"最终/定稿"，实际使用中这类文件常有多个版本，注意别发错。',
    weight: 45,
  },
  {
    test: /(副本|copy|backup|备份|bak\b|旧|old)/i,
    tag: '副本',
    text: '像是某个文件的副本或备份，确认原件还在再考虑清理。',
    weight: 40,
  },
];

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  const text = value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1);
  return `${text} ${units[i]}`;
}

function relativeDays(ms) {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return null;
  return Math.floor(diff / 86400000);
}

/**
 * 收集语境提示，按权重从高到低取。
 * @returns {{tag:string,text:string,weight:number}[]}
 */
function collectHints(entry) {
  const name = entry.name || '';
  const hits = RULES.filter((rule) => rule.test.test(name)).map((r) => ({
    tag: r.tag,
    text: r.text,
    weight: r.weight,
  }));

  const size = Number(entry.size) || 0;
  if (!entry.isDir && size === 0) {
    hits.push({ tag: '空文件', text: '这是一个空文件（0 字节），多半是下载失败或占位文件。', weight: 90 });
  } else if (!entry.isDir && size > 1024 ** 3) {
    hits.push({ tag: '大文件', text: `体积约 ${humanSize(size)}，拷贝和备份都会比较费时。`, weight: 30 });
  }

  const days = relativeDays(entry.mtime);
  if (days !== null && days > 730) {
    hits.push({ tag: '很久未改', text: `已经两年多没有改动过，如果确认没用可以归档或删除。`, weight: 20 });
  }

  // 同一优先级只保留一条，避免列表里堆三句提示
  return hits.sort((a, b) => b.weight - a.weight);
}

/**
 * 列表用的轻量说明。
 * @param {{name:string,ext?:string,size?:number,isDir?:boolean,mtime?:number}} entry
 */
function summarize(entry) {
  if (entry.isDir) {
    return {
      label: '文件夹',
      category: 'folder',
      brief: '文件夹，双击进入查看里面的内容。',
    };
  }
  const ext = String(entry.ext || '').toLowerCase();
  const type = TYPES[ext] || fallbackByExt(ext);
  const hints = collectHints(entry);
  // 只取最高权重的语境提示，保证"一句话"
  const top = hints[0];
  const brief = top && top.weight >= 45 ? top.text : type.brief;
  return { label: type.label, category: type.cat, brief };
}

/**
 * 详情栏用的完整说明。
 */
function detailOf(entry) {
  if (entry.isDir) {
    return {
      label: '文件夹',
      category: 'folder',
      brief: '文件夹，双击进入查看里面的内容。',
      detail: '文件夹本身不占空间，它的大小取决于里面装了什么。右键可以看到更详细的信息。',
      hints: [],
      size: '',
    };
  }
  const ext = String(entry.ext || '').toLowerCase();
  const type = TYPES[ext] || fallbackByExt(ext);
  const hints = collectHints(entry);
  const detail = [type.brief, type.extra].filter(Boolean).join(' ');
  return {
    label: type.label,
    category: type.cat,
    brief: type.brief,
    detail,
    hints: hints.slice(0, 3),
    size: humanSize(entry.size),
  };
}

module.exports = { summarize, detailOf, CATEGORIES, TYPES, humanSize };

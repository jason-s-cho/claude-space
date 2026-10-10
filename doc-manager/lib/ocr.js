// 스캔 PDF 글자 읽기(OCR): 윈도우에 들어 있는 기능만 쓴다 (따로 설치할 것 없음).
//   - Windows.Data.Pdf 로 페이지를 그림으로 그리고, Windows.Media.Ocr(한국어)로 글자를 읽는다.
//   - 윈도우 PowerShell 5.1 에서 WinRT 를 부른다 (pwsh 7 은 WinRT 를 못 쓴다).
// 읽은 글자는 <문서 폴더>/.docmanager/ocr/<파일 내용 지문>.json 에 남겨, 같은 파일은 다시 읽지 않는다
// (문서 폴더를 따라가므로 다른 PC에서도 다시 읽을 필요가 없다. 파일 이름·위치가 바뀌어도 내용이 같으면 그대로 쓴다).
const fs = require("fs");
const path = require("path");
const store = require("./store");
const { runPowerShell } = require("./convert");
const { hashFile } = require("./duplicates");

const CACHE_VERSION = 1;
const AUTO_MAX_PAGES = 60; // 자동으로 읽을 때 앞에서부터 이만큼 (전부 읽기는 문서 화면 버튼으로)

// 글자가 거의 없는 PDF = 스캔본으로 본다 (페이지당 20자 미만)
function needsOcr(entry) {
  if (!entry || !/\.pdf$/i.test(entry.rel || "") || entry.error || entry.protectedText) return false;
  const pages = entry.pages || 0;
  if (!pages) return false;
  const len = String(entry.text || "").replace(/\s+/g, "").length;
  return len < 20 * pages;
}

const cacheDir = (root) => path.join(store.paths(root).dir, "ocr");
const cacheFile = (root, sha1) => path.join(cacheDir(root), sha1 + ".json");

function readCache(root, sha1) {
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile(root, sha1), "utf8"));
    if (c && c.v === CACHE_VERSION && Array.isArray(c.pages)) return c;
  } catch {}
  return null;
}

function writeCache(root, sha1, data) {
  if (!store.ensureDir(root)) return false;
  fs.mkdirSync(cacheDir(root), { recursive: true });
  const f = cacheFile(root, sha1);
  fs.writeFileSync(f + ".tmp", JSON.stringify({ v: CACHE_VERSION, ...data }));
  fs.renameSync(f + ".tmp", f);
  return true;
}

const joinPages = (pages) => pages.map((p) => String(p || "").trim()).filter(Boolean).join("\n");

// 파일의 OCR 결과가 남아 있으면 글자를 돌려준다 (없으면 null)
async function cachedText(root, full) {
  try {
    const c = readCache(root, await hashFile(full));
    return c ? { text: joinPages(c.pages), pages: c.pages.length, total: c.total, lang: c.lang } : null;
  } catch {
    return null;
  }
}

// 윈도우 PowerShell 5.1 스크립트. 진행은 {"page":n,"of":N} 줄로, 끝은 {"ok":true,...} 줄로 알린다.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Send($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
} catch { Send @{ ok = $false; code = 'noapi'; error = $_.Exception.Message }; exit 0 }

$asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation` + "`" + String.raw`1' })[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]
function Await($op, [Type]$type) { $t = $asTaskOp.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
function AwaitAction($action) { $t = $asTaskAction.Invoke($null, @($action)); $t.Wait(-1) | Out-Null }

try {
  $engine = $null
  foreach ($tag in @($env:DM_LANG, 'ko', 'ko-KR')) {
    if (-not $tag) { continue }
    try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $tag)) } catch {}
    if ($engine) { break }
  }
  $fallback = $false
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages(); $fallback = $true }
  if (-not $engine) { Send @{ ok = $false; code = 'nolang'; error = 'no OCR language' }; exit 0 }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:DM_SRC)) ([Windows.Storage.StorageFile])
  $pdf = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
  $total = [int]$pdf.PageCount
  $count = [Math]::Min($total, [int]$env:DM_MAXPAGES)
  $max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
  $pages = @()
  for ($i = 0; $i -lt $count; $i++) {
    Send @{ page = $i + 1; of = $count }
    $page = $pdf.GetPage([uint32]$i)
    try {
      # 약 200dpi 로 그리되 OCR 이 받는 최대 크기를 넘지 않게
      $scale = 200.0 / 96.0
      $w = $page.Size.Width * $scale; $h = $page.Size.Height * $scale
      $fit = [Math]::Min(1.0, ($max - 1) / [Math]::Max($w, $h))
      $opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
      $opts.DestinationWidth = [uint32]([Math]::Floor($w * $fit))
      $opts.DestinationHeight = [uint32]([Math]::Floor($h * $fit))
      $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
      AwaitAction ($page.RenderToStreamAsync($stream, $opts))
      $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
      $pages += ,((@($result.Lines) | ForEach-Object { $_.Text }) -join "` + "`n" + String.raw`")
      $bitmap.Dispose(); $stream.Dispose()
    } finally { $page.Dispose() }
  }
  Send @{ ok = $true; total = $total; pages = $pages; lang = $engine.RecognizerLanguage.LanguageTag; fallback = $fallback }
} catch {
  Send @{ ok = $false; error = $_.Exception.Message }
}
`;

/**
 * PDF 를 OCR 로 읽는다. 결과: { pages: [페이지별 글자], total: 전체 페이지 수, lang }
 * onProgress({ page, of })
 */
async function ocrPdf(full, { maxPages = AUTO_MAX_PAGES, lang = "ko", run = runPowerShell, platform = process.platform, onProgress } = {}) {
  if (platform !== "win32") throw new Error("스캔 PDF 글자 읽기는 윈도우에서만 됩니다");
  if (!fs.existsSync(full)) throw new Error("파일이 없습니다: " + full);
  const r = await run(SCRIPT, { DM_SRC: full, DM_MAXPAGES: String(Math.max(1, maxPages | 0)), DM_LANG: lang }, {
    timeoutMs: Math.max(3, Math.ceil(maxPages / 10) * 3) * 60 * 1000,
    onLine: (o) => o && o.page && onProgress && onProgress(o),
  });
  if (!r || !r.ok) {
    if (r && r.code === "nolang")
      throw new Error("이 PC에 글자 인식(OCR) 언어가 없습니다. 윈도우 설정 > 시간 및 언어 > 언어 및 지역 > 한국어 > 언어 옵션에서 '광학 문자 인식'을 설치해 주세요.");
    if (r && r.code === "noapi") throw new Error("이 윈도우에서는 글자 인식 기능을 쓸 수 없습니다 (윈도우 10 이상 필요): " + (r.error || ""));
    throw new Error("글자를 읽지 못했습니다: " + ((r && r.error) || "알 수 없는 오류"));
  }
  const pages = (Array.isArray(r.pages) ? r.pages : [r.pages]).map((p) => String(p == null ? "" : p));
  return { pages, total: r.total || pages.length, lang: r.lang || "", fallback: !!r.fallback };
}

/**
 * 캐시를 먼저 보고, 없으면 OCR 해서 캐시에 남긴다.
 * full: 전체 페이지를 원하면 maxPages 를 크게. 캐시가 일부만 읽은 것이면 더 읽는다.
 * 결과: { text, pages(읽은 수), total, lang, fromCache }
 */
async function ocrWithCache(root, full, opts = {}) {
  const sha1 = await hashFile(full);
  const want = opts.maxPages || AUTO_MAX_PAGES;
  const c = readCache(root, sha1);
  if (c && (c.pages.length >= want || c.pages.length >= c.total)) return { text: joinPages(c.pages), pages: c.pages.length, total: c.total, lang: c.lang, fromCache: true };
  const r = await ocrPdf(full, { ...opts, maxPages: want });
  writeCache(root, sha1, { pages: r.pages, total: r.total, lang: r.lang, at: new Date().toISOString(), name: path.basename(full) });
  return { text: joinPages(r.pages), pages: r.pages.length, total: r.total, lang: r.lang, fromCache: false };
}

module.exports = { AUTO_MAX_PAGES, needsOcr, readCache, writeCache, cachedText, ocrPdf, ocrWithCache, joinPages, SCRIPT };

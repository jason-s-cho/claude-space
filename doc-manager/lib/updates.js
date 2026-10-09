// 새 버전 알림: GitHub 릴리스에서 문서 보관함의 최신 버전을 찾아 지금 버전과 비교한다.
// 저장소에는 다른 프로젝트의 릴리스도 있으므로 태그가 docmanager-v 로 시작하는 것만 본다.
// 설치는 사용자가 한다 (받기를 누르면 브라우저로 설치 파일을 내려받음). 앱이 몰래 설치하지 않는다.
const REPO = "jason-s-cho/claude-space";
const TAG_PREFIX = "docmanager-v";
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

// "0.2.41" → [0, 2, 41]
function parseVersion(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? m.slice(1).map(Number) : null;
}

function newer(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// 이 컴퓨터에 맞는 설치 파일
function assetFor(assets, platform) {
  const want = platform === "win32" ? /\.exe$/i : platform === "darwin" ? /\.dmg$/i : /\.AppImage$/i;
  return (assets || []).find((a) => want.test(a.name) && !/blockmap/i.test(a.name)) || null;
}

/**
 * 결과: { available, current, latest, url(설치 파일), page(릴리스 화면), notes, publishedAt } 또는 { error }
 * fetchJson(url) → JSON (시험할 때 바꿔 넣는다)
 */
async function checkForUpdate(current, { fetchJson, platform = process.platform } = {}) {
  try {
    const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases?per_page=30`);
    if (!Array.isArray(list)) throw new Error("릴리스 목록을 읽을 수 없습니다");
    const mine = list
      .filter((r) => r && !r.draft && !r.prerelease && String(r.tag_name || "").startsWith(TAG_PREFIX))
      .map((r) => ({ r, version: String(r.tag_name).slice(TAG_PREFIX.length) }))
      .filter((x) => parseVersion(x.version))
      .sort((a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0));
    if (!mine.length) return { available: false, current, latest: null, page: RELEASES_PAGE };
    const top = mine[0];
    const asset = assetFor(top.r.assets, platform);
    return {
      available: newer(top.version, current) && !!asset,
      current,
      latest: top.version,
      url: asset ? asset.browser_download_url : top.r.html_url,
      page: top.r.html_url || RELEASES_PAGE,
      notes: String(top.r.body || "").slice(0, 2000),
      publishedAt: top.r.published_at || null,
    };
  } catch (e) {
    return { error: String((e && e.message) || e), current, page: RELEASES_PAGE };
  }
}

module.exports = { checkForUpdate, newer, parseVersion, assetFor, RELEASES_PAGE, TAG_PREFIX };

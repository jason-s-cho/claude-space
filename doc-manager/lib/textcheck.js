// 문서 본문 글자 점검 (가벼운 함수만: 분류·커넥터·OCR 이 같이 쓴다)

// 글자 정보가 깨진 PDF: 화면에는 제대로 보이지만 안에 든 글자가 기호 덩어리인 것
// (글꼴의 글자표가 빠진 PDF. 홈택스 증명서, 일부 한글→PDF 등). 이런 PDF 도 글자 인식으로 다시 읽는다.
//   - 연달아 이어지는 문자 코드("!\"#$%&'()*+,-./0123", "@ABCDE", "cdefgh")가 여러 번 나오거나
//   - 선·도형·화살표·라틴 기호(┐│▒◘↕¦¤) 같은 글자가 많거나
//   - 한글·영문·숫자가 아닌 글자가 너무 많으면
function garbledText(text) {
  const t = String(text || "").replace(/\s+/g, "").slice(0, 6000);
  if (t.length < 40) return false;
  let runs = 0, run = 1, weird = 0, plain = 0, neutral = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (i && c === t.charCodeAt(i - 1) + 1 && c < 0x7f) {
      if (++run === 6) runs++;
    } else run = 1;
    if ((c >= 0x2190 && c <= 0x21ff) || (c >= 0x2500 && c <= 0x25ff) || (c >= 0x2600 && c <= 0x26ff) || (c >= 0xa1 && c <= 0xbf) || c < 0x20 || (c >= 0xe000 && c <= 0xf8ff) || c === 0xfffd) weird++;
    if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) plain++;
    else if (".,:;()%-/·~".includes(t[i])) neutral++; // 목차 점선·표의 숫자 구분은 깨진 글자가 아니다
  }
  const rest = Math.max(1, t.length - neutral);
  return runs >= 3 || weird / t.length > 0.12 || plain / rest < 0.45;
}

module.exports = { garbledText };

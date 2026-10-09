const test = require("node:test");
const assert = require("node:assert");
const { countTerms, docFrequency, topKeywords, stripSuffix } = require("../lib/keywords");

test("조사·어미 떼기", () => {
  assert.strictEqual(stripSuffix("그래핀을"), "그래핀");
  assert.strictEqual(stripSuffix("모듈에서의"), "모듈");
  assert.strictEqual(stripSuffix("수행되었으며"), "수행");
  assert.strictEqual(stripSuffix("센서"), "센서");
});

test("이 문서에 많이 나오는 단어와 두 단어 묶음을 고른다", () => {
  const a = countTerms("그래핀 센서를 이용한 전자파 차폐 소재. 그래핀 센서의 감도와 전자파 차폐 필름. 그래핀 센서 시제품, 전자파 차폐 성능 60dB. KEIT 과제");
  const b = countTerms("회사소개 연혁 제품 카탈로그 제품 사양 모델명 제품 라인업");
  const kw = topKeywords(a, docFrequency([a, b]), 2);
  assert.ok(kw.includes("전자파 차폐"));
  assert.ok(kw.includes("그래핀 센서"));
  assert.ok(kw.includes("KEIT"));
  assert.ok(!kw.some((k) => /60/.test(k)));
});

test("거의 모든 문서에 나오는 단어는 핵심 키워드가 아니다", () => {
  const lists = Array.from({ length: 10 }, (_, i) => countTerms(`에이비씨 에이비씨 주제${"가나다라마바사아자차"[i]}단어 주제${"가나다라마바사아자차"[i]}단어`));
  const df = docFrequency(lists);
  assert.ok(!topKeywords(lists[0], df, 10).includes("에이비씨"));
});

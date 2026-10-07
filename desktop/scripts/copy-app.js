// ../schedule/index.html 을 desktop/app/ 으로 복사한다.
// 웹 버전과 데스크톱 버전이 같은 원본 파일을 쓰도록 하기 위함.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "schedule", "index.html");
const destDir = path.join(__dirname, "..", "app");
const dest = path.join(destDir, "index.html");

if (!fs.existsSync(src)) {
  console.error("원본을 찾을 수 없습니다: " + src);
  process.exit(1);
}
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log("복사 완료: " + path.relative(process.cwd(), dest));

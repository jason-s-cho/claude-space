# PyInstaller 설정: Windows 는 폴더형(onedir) → Inno Setup 으로 설치 파일,
# macOS 는 '논문 서재.app' → .dmg 로 묶는다.
# 실행: pyinstaller packaging/papershelf.spec  (papers/ 폴더에서)
import sys
from pathlib import Path

ROOT = Path(SPECPATH).parent
VERSION = "1.0.0"
for line in (ROOT / "app.py").read_text(encoding="utf-8").splitlines():
    if line.startswith("APP_VERSION"):
        VERSION = line.split("=")[1].strip().strip('"')

a = Analysis(
    [str(ROOT / "app.py")],
    pathex=[str(ROOT)],
    datas=[(str(ROOT / "static"), "static")],
    hiddenimports=["tray", "pystray._win32" if sys.platform == "win32" else
                   "pystray._darwin" if sys.platform == "darwin" else "pystray._xorg"],
    excludes=["tkinter", "unittest", "pydoc"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, [],
    exclude_binaries=True,
    name="PaperShelf",
    console=False,
    icon=str(ROOT / "static" / ("icon.ico" if sys.platform == "win32" else "icon.png")),
)
coll = COLLECT(exe, a.binaries, a.datas, name="PaperShelf")

if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="논문 서재.app",
        icon=str(ROOT / "static" / "icon.png"),
        bundle_identifier="io.github.jason-s-cho.papershelf",
        version=VERSION,
        info_plist={
            "CFBundleDisplayName": "논문 서재",
            "CFBundleShortVersionString": VERSION,
            "LSUIElement": True,  # Dock 대신 메뉴 막대 아이콘으로 동작
            "NSHighResolutionCapable": True,
        },
    )

"""알림 영역(Windows)·메뉴 막대(macOS) 아이콘. 설치판에서만 쓴다."""

import webbrowser

import pystray
from PIL import Image


def make(icon_path, url, open_folder, quit):
    def on_quit(icon, item):
        quit()
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("논문 서재 열기", lambda icon, item: webbrowser.open(url), default=True),
        pystray.MenuItem("논문 폴더 열기", lambda icon, item: open_folder()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("종료", on_quit),
    )
    return pystray.Icon("papershelf", Image.open(icon_path), "논문 서재", menu)

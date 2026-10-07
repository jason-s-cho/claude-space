"""브라우저 없이 자체 창으로 띄우기 (pywebview).

Windows 는 Edge WebView2, macOS 는 WebKit 을 빌려 쓴다. 주소창·탭이 없는 일반 프로그램 창이다.
"""

import platform
from pathlib import Path

STORAGE_DIR = Path.home() / ".papershelf-webview"  # 화면 설정(localStorage)을 기억할 곳

_window = None


def available():
    try:
        import webview  # noqa: F401
        return True
    except Exception:
        return False


def selftest():
    """설치판 점검용: 창 엔진을 실제로 불러올 수 있는지."""
    import webview  # noqa: F401
    system = platform.system()
    if system == "Windows":
        import webview.platforms.winforms  # noqa: F401  (.NET·WebView2 연결)
    elif system == "Darwin":
        import webview.platforms.cocoa  # noqa: F401
    return True


def run(url, title, minimized=False):
    """창을 띄우고, 창이 닫힐 때까지 기다린다(메인 스레드에서 불러야 한다)."""
    global _window
    import webview

    _window = webview.create_window(title, url, width=1280, height=860, min_size=(760, 560),
                                    minimized=minimized, text_select=True, zoomable=True)
    gui = {"Windows": "edgechromium", "Darwin": "cocoa"}.get(platform.system())
    STORAGE_DIR.mkdir(exist_ok=True)
    webview.start(gui=gui, private_mode=False, storage_path=str(STORAGE_DIR))
    _window = None


def close():
    if _window is not None:
        _window.destroy()


def show():
    """이미 켜진 창을 앞으로 불러온다."""
    if _window is None:
        return False
    try:
        _window.restore()
    except Exception:
        pass
    _window.show()
    try:  # 다른 창 뒤에 숨어 있으면 맨 앞으로
        _window.on_top = True
        _window.on_top = False
    except Exception:
        pass
    return True


def save_dialog(filename, label, pattern):
    """저장 위치를 고르는 창. 고른 경로(문자열) 또는 None."""
    import webview

    if _window is None:
        return None
    kind = webview.FileDialog.SAVE if hasattr(webview, "FileDialog") else webview.SAVE_DIALOG
    res = _window.create_file_dialog(kind, save_filename=filename, file_types=(f"{label} ({pattern})",))
    if not res:
        return None
    return res[0] if isinstance(res, (list, tuple)) else res

import sys
import subprocess
import time
import webview
import os
import atexit
import urllib.request
import socket
import threading

# 获取当前文件所在目录，方便后续路径
BASE_DIR = os.path.dirname(sys.executable) if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
LOG_PATH = os.path.join(BASE_DIR, 'desktop_backend.log')
STORAGE_PATH = os.path.join(BASE_DIR, 'data', 'webview_profile')

def log(message):
    timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
    with open(LOG_PATH, 'a', encoding='utf-8') as f:
        f.write(f'[{timestamp}] {message}\n')
        f.flush()

# 前端 API 类（供 JavaScript 调用）
class Api:
    def __init__(self, window, process):
        self.window = window
        self.process = process

    def quit(self):
        """关闭窗口并终止 uvicorn 进程"""
        stop_process(self.process)
        self.window.destroy()

def get_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def can_reuse_server(url):
    try:
        with urllib.request.urlopen(f'{url}/api/proxy/models', timeout=1) as response:
            return response.status == 200
    except Exception:
        return False

def is_port_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex(('127.0.0.1', port)) != 0

def start_uvicorn(port):
    """
    在子进程中启动 uvicorn 服务器
    注意：必须指定 main:app，假设 main.py 中有 app 对象
    """
    log_file = open(LOG_PATH, 'a', encoding='utf-8')
    cmd = [
        sys.executable, '-m', 'uvicorn',
        'backend.main:app',
        '--host', '127.0.0.1',
        '--port', str(port),
        '--log-level', 'info'
    ]
    log('starting backend: ' + ' '.join(cmd))
    startupinfo = None
    creationflags = 0
    if os.name == 'nt':
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        creationflags = subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(
        cmd,
        cwd=BASE_DIR,
        stdout=log_file,
        stderr=log_file,
        startupinfo=startupinfo,
        creationflags=creationflags,
    )
    process._slate_log_file = log_file
    return process

def start_embedded_uvicorn(port):
    os.environ['SLATE_DATA_DIR'] = os.path.join(BASE_DIR, 'data')
    log_file = open(LOG_PATH, 'a', encoding='utf-8')
    log(f'starting embedded backend on port {port}')

    def run():
        try:
            sys.stdout = log_file
            sys.stderr = log_file
            import uvicorn
            from backend.main import app
            config = uvicorn.Config(app, host='127.0.0.1', port=port, log_level='info')
            server = uvicorn.Server(config)
            thread.server = server
            server.run()
        except Exception as exc:
            log(f'embedded backend crashed: {exc}')
        finally:
            log_file.flush()

    thread = threading.Thread(target=run, daemon=True)
    thread._slate_log_file = log_file
    thread.server = None
    thread.start()
    return thread

def wait_for_server(process, url, timeout=20):
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        if hasattr(process, 'poll') and process.poll() is not None:
            return False, f'backend exited with code {process.returncode}'
        try:
            with urllib.request.urlopen(f'{url}/api/proxy/models', timeout=1) as response:
                if response.status == 200:
                    log(f'backend ready: {url}')
                    return True, ''
        except Exception as exc:
            last_error = exc
        time.sleep(0.3)
    return False, str(last_error) if last_error else 'timeout'

def stop_process(process):
    if not process:
        return
    log('stopping backend')
    if hasattr(process, 'server') and process.server:
        process.server.should_exit = True
        process.join(timeout=5)
        log_file = getattr(process, '_slate_log_file', None)
        if log_file:
            log_file.close()
        return
    if process and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    log_file = getattr(process, '_slate_log_file', None)
    if log_file:
        log_file.close()

def main():
    # 1. 启动 uvicorn 服务器
    open(LOG_PATH, 'w', encoding='utf-8').close()
    os.makedirs(STORAGE_PATH, exist_ok=True)
    print("正在启动后端服务器...")
    preferred_port = 8000
    preferred_url = f'http://127.0.0.1:{preferred_port}'
    uvicorn_process = None
    frozen = getattr(sys, 'frozen', False)

    if not frozen and can_reuse_server(preferred_url):
        port = preferred_port
        app_url = preferred_url
        log(f'reusing existing backend: {app_url}')
    elif is_port_free(preferred_port):
        port = preferred_port
        app_url = preferred_url
    else:
        port = get_free_port()
        app_url = f'http://127.0.0.1:{port}'
        log(f'port {preferred_port} is busy; using fallback port {port}')

    log(f'app url: {app_url}')
    if uvicorn_process is None and not can_reuse_server(app_url):
        uvicorn_process = start_embedded_uvicorn(port) if frozen else start_uvicorn(port)
        atexit.register(stop_process, uvicorn_process)
        ready, error = wait_for_server(uvicorn_process, app_url)
        if not ready:
            log(f'backend failed: {error}')
            stop_process(uvicorn_process)
            webview.create_window(
                title='SLATE 砚',
                html=f'<h2>SLATE backend failed to start</h2><p>{error}</p><p>See desktop_backend.log.</p>',
                width=720,
                height=360,
            )
            webview.start(debug=False)
            return

    # 2. 创建 pywebview 窗口，加载本地地址
    log('creating window')
    window = webview.create_window(
        title='SLATE 砚',
        url=app_url,
        width=1200,
        height=800,
        resizable=True,
        confirm_close=False
    )

    # 3. 启动 pywebview 事件循环（阻塞）
    log('starting webview')
    webview.start(
        debug=False,
        gui='edgechromium',
        private_mode=False,
        storage_path=STORAGE_PATH,
    )
    log('webview closed')

    # 4. 窗口关闭后，确保子进程终止（以防万一）
    stop_process(uvicorn_process)

if __name__ == '__main__':
    main()

"""验证独立 API 测试环境的页面交互和布局，不操作正式浏览器资料。"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--fixture', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--browser', required=True)
args = parser.parse_args()
fixture = json.loads(Path(args.fixture).read_text(encoding='utf-8'))
endpoint = urlparse(fixture['url'])
assert endpoint.hostname == '127.0.0.1' and endpoint.port != 17865, '只允许独立随机端口测试服务'
# Repeatable runs start from account mode even when reusing the same fixture process.
reset = Request(fixture['url'] + '/settings', data=b'{"provider":"codex","clearApiKey":true}', headers={'Authorization': 'Bearer ' + fixture['token'], 'Content-Type': 'application/json'})
with urlopen(reset) as response:
    assert response.status == 200
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
root = Path(__file__).resolve().parent.parent
checks, errors = [], []

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=args.browser, headless=True)
    page = browser.new_page(viewport={'width': 1280, 'height': 1000}, device_scale_factor=1)
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(fixture['url'] + '/#token=' + fixture['token'] + '&section=api')
    expect(page.locator('#api-state')).to_contain_text('尚未启用')
    assert page.url.endswith('/#api-panel') and 'token=' not in page.url
    assert page.locator('#api-panel').evaluate('(el) => el === document.activeElement')
    expect(page.locator('#apiBaseUrl')).to_be_visible()
    checks.append('账号模式下 API 字段可见；直达定位和焦点正确；地址移除配对码')
    page.locator('#apiBaseUrl').fill(fixture['baseUrl'])
    page.locator('#apiMode').select_option('chat-completions')
    page.locator('#apiModel').fill('vendor/test-model')
    page.locator('#apiKey').fill('dummy-api-fixture-key')
    page.locator('#rememberApiKey').uncheck()
    page.locator('#test-api').click()
    expect(page.locator('#api-feedback')).to_contain_text('API 连接测试成功')
    expect(page.locator('#apiKey')).to_have_value('')
    expect(page.locator('#api-key-state')).to_contain_text('仅本次运行')
    expect(page.locator('#provider')).to_have_value('api')
    checks.append('Chat Completions 保存并启用后完成真实 HTTP 模拟翻译，清空密钥输入')
    page.locator('#api-panel').screenshot(path=str(out / 'api-desktop.png'))
    page.locator('#apiMode').select_option('responses')
    page.locator('#test-api').click()
    expect(page.locator('#api-feedback')).to_contain_text('API 连接测试成功')
    checks.append('Responses 切换后完成真实 HTTP 模拟翻译，留空保留已有密钥')
    page.locator('#apiKey').fill('dummy-rejected-key')
    page.locator('#test-api').click()
    expect(page.locator('#api-feedback')).to_contain_text('API 密钥或模型访问权限无效')
    expect(page.locator('#result')).to_be_hidden()
    page.locator('#api-panel').screenshot(path=str(out / 'api-error.png'))
    checks.append('更换错误密钥后显示鉴权失败，不沿用缓存成功结果')
    page.locator('#clear-key').click()
    expect(page.locator('#api-key-state')).to_contain_text('未配置')
    page.locator('#apiBaseUrl').fill('not-a-url')
    page.locator('#test-api').click()
    assert not page.locator('#apiBaseUrl').evaluate('(el)=>el.validity.valid')
    expect(page.locator('#apiKey')).to_be_enabled()
    checks.append('移除密钥状态更新；非法 URL 在提交前被表单阻止')
    page.locator('#apiBaseUrl').fill(fixture['baseUrl'])
    page.locator('#apiMode').select_option('chat-completions')
    page.locator('#apiKey').fill('dummy-api-fixture-key')
    page.locator('#test-api').click()
    expect(page.locator('#api-feedback')).to_contain_text('API 连接测试成功')
    page.set_viewport_size({'width': 390, 'height': 844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.locator('#api-panel').screenshot(path=str(out / 'api-mobile.png'))
    checks.append('390px 窄屏无横向溢出，输入与按钮可用')
    page.reload()
    expect(page.locator('#api-key-state')).to_contain_text('已配置')
    expect(page.locator('#apiModel')).to_have_value('vendor/test-model')
    expect(page.locator('#apiMode')).to_have_value('chat-completions')
    checks.append('重新加载设置页保留已保存的接口、模型、协议和密钥状态')

    popup = browser.new_page(viewport={'width': 370, 'height': 600}, device_scale_factor=1)
    popup.on('pageerror', lambda error: errors.append(str(error)))
    extension = root / 'outputs/youtube-zh-assistant/extension'
    def serve(route):
        name = route.request.url.split('/')[-1] or 'popup.html'
        allowed = {'popup.html', 'popup.css', 'popup.js', 'core.js', 'icon128.png'}
        if name not in allowed:
            route.abort()
        else:
            mime = 'text/css' if name.endswith('.css') else 'text/javascript' if name.endswith('.js') else 'image/png' if name.endswith('.png') else 'text/html'
            route.fulfill(path=str(extension / name), content_type=mime)
    popup.route('**/popup-preview/*', serve)
    popup.add_init_script('window.__previewVersion=' + json.dumps(json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))['version']) + ';')
    popup.add_init_script("""
      window.__sent=[];
      window.chrome={runtime:{getManifest:()=>({version:window.__previewVersion}),sendMessage:async m=>{
        window.__sent.push(m);
        if(m.type==='GET_SETTINGS')return {ok:true,paired:true,enabled:false,audioStatus:{running:false}};
        if(m.type==='GET_SITE')return {ok:true,youtube:true,origin:'https://www.youtube.com'};
        return {ok:true};
      }},tabs:{query:async()=>[{id:1}]}};
    """)
    popup.goto(fixture['url'] + '/popup-preview/popup.html')
    expect(popup.locator('#apiSettings')).to_be_in_viewport()
    popup.locator('#apiSettings').click()
    assert popup.evaluate("__sent.some(m=>m.type==='OPEN_SETTINGS' && m.section==='api')")
    popup.screenshot(path=str(out / 'popup.png'))
    checks.append('370×600 插件弹窗首屏显示 API 入口，点击发出直达板块消息（模拟 Chrome API）')
    assert not errors, errors
    checks.append('设置页与弹窗无 JavaScript 页面异常')
    browser.close()

report = {'passed': True, 'checks': checks, 'browser': '独立临时资料的无头 Microsoft Edge', 'limitations': ['上游为本机模拟接口，未使用第三方真实账号', '弹窗使用模拟 Chrome API，未加载到日常浏览器', '未连接正式服务、配对码或 GPU']}
(out / 'ui-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'passed': True, 'checks': len(checks)}, ensure_ascii=False))

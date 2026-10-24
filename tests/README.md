浏览器回归验证

在仓库根目录安装测试依赖后运行：

```powershell
python -m pip install -r requirements-dev.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
node --check zhihu-voice-insight.user.js
```

全部请求使用本地 GM／HTTP 样本，不访问真实知乎或模型接口，不使用登录态和 API Key。

覆盖原版整页消失的反例、隐藏／折叠作用范围、同作者多卡片与白名单、隐藏后的恢复入口、动态加载和节点复用、关闭后的迟到响应、缓存配置失效、窗口边界及去重、摘要可靠性、HTML 兜底作者归属、静止页面无空转、移动端宽度和不受最近条数截断的高频明细。

其中原版反例从 Git 提交 `29def6115c2b967d47ee5584bf2b127f7292beda` 读取旧脚本，确认故障可重现；其余用例检查当前版本的预期行为。测试结束生成 `review/2.8.0-evidence.png`，是本地构造页面的布局截图。

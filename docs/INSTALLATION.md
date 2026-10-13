# ChatScope Windows 安装版

## 安装与使用

1. 下载并双击 `ChatScope-Setup-0.1.1-x64.exe`。
2. 按提示完成安装，可选择创建桌面快捷方式。
3. 打开并登录电脑微信，再从桌面或开始菜单启动 ChatScope。
4. 首次在“模型设置”保存 DeepSeek / 兼容接口的 API Key。之后选择好友或群聊即可提问。

支持 Windows x64、微信 4.x。安装到当前 Windows 用户的 `%LOCALAPPDATA%\Programs\ChatScope`，无需管理员权限。运行环境和聊天读取模块已经内置。

## 升级与数据

安装前关闭正在运行的 ChatScope。再次运行安装包可以更新程序文件。

运行数据保存在安装目录的 `data` 文件夹。卸载程序会移除已安装的程序文件和快捷方式，**保留使用过程中产生的 `data` 文件夹**。重新安装到原目录可以继续使用这些数据。

如果之前使用的是免安装版，先关闭旧版。如需沿用配置和记录，将旧版的整个 `data` 文件夹复制到安装目录。两者需使用相同的 Windows 账户，才能解密原来保存的密钥。请不要覆盖你需要保留的另一份数据。

安装包和免安装版使用同一份 v0.1.1 程序，均支持 Markdown 模型回复、代码复制和可点击的原文引用。

## 安装包构建

使用 Inno Setup 7.1.0 x64，输入为本发布页上的 `ChatScope-Windows-x64.zip`。构建脚本见 GitHub 的 `scripts/installer.iss`、`scripts/prepare_installer.py`，以及 Release 中的 `ChatScope-installer-source.zip`。

恢复 `work/` 布局，将这两个脚本放入 `work`，并把免安装 ZIP 放在项目 `outputs` 下。安装 Python Pillow 后执行 `python work/prepare_installer.py`，将 Inno Setup 的原始 `License.txt` 复制到生成目录的 `licenses/Inno-Setup-LICENSE.txt`，再使用：

```powershell
ISCC.exe /Q "/DPayload=<项目绝对路径>\work\installer-payload\ChatScope" "/DDestination=<项目绝对路径>\outputs" work/installer.iss
```

`test_installer.py` 在工作目录中隔离安装，验证程序启动、ChatLab 分析和 Markdown 显示，然后卸载并检查数据仍然保留。测试模式 `/QAINSTALL=1` 不创建桌面 / 开始菜单入口，也不注册正式卸载项。

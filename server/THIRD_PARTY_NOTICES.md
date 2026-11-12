# 第三方组件许可声明

本项目自身以 **Apache License 2.0** 授权（见 `LICENSE`）。分发时包含以下第三方组件，其许可如下。

## 1. Node.js

- 项目：https://nodejs.org/
- 许可：MIT（Node.js 分发包内还包含若干第三方组件的许可，见 `LICENSES/Node.js-LICENSE.txt`）
- 使用方式：通过 Node.js SEA（Single Executable Application）打包进 `EasyTunnelClient.exe`，作为运行时随客户端分发。
- 义务：分发包含 Node.js 的二进制时，需随附其许可文本与版权声明。本仓库已在 `LICENSES/Node.js-LICENSE.txt` 提供，并随客户端压缩包一起分发。

## 2. rcedit

- 项目：https://github.com/electron/rcedit
- 版本：2.0.0
- 许可：MIT
- 版权：Copyright (C) 2013 GitHub, Inc.
- 使用方式：构建期工具（`source/tools/rcedit.exe`），用于写入 exe 图标与版本信息；不参与运行时。
- 义务：随源码/构建包分发该二进制时需附 MIT 许可与版权声明。

```
MIT License

Copyright (c) 2013 GitHub, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 3. postject

- 项目：https://github.com/nodejs/postject
- 许可：MIT
- 使用方式：仅构建期使用（通过 `npx` 获取），不随任何发布包分发，因此无分发义务；此处记录以备审计。

## 4. 未使用的组件说明

- 管理控制台 `admin.html` 为单文件实现，**未引用任何 CDN、外部 JS/CSS 或字体文件**。
- 客户端图形界面使用 Windows 自带 PowerShell/WinForms 与系统字体，不随包分发第三方 UI 库。
- 运行时无 npm 依赖（服务端仅使用 Node.js 标准库）。

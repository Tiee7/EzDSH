!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Welcome to EzDSH Setup"
  !define MUI_WELCOMEPAGE_TEXT "首次安装可能需要较长时间。$$
$$
安装程序正在解压应用、内置 Node.js 运行时及 DSH 依赖，请勿关闭窗口。$$
$$
实际耗时取决于磁盘速度、杀毒软件和系统性能。$$
$$
First-time installation may take a while.$$
$$
The installer is extracting the application, bundled Node.js runtime, and DSH dependencies. Please do not close this window.$$
$$
Actual installation time depends on disk speed, antivirus software, and system performance."
  !insertmacro MUI_PAGE_WELCOME
!macroend

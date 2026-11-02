@echo off
setlocal
chcp 65001 >nul
echo 请先关闭使用同一个 DSH home 的其他 DSH 进程。
echo 此操作覆盖聊天库并备份旧库，保留常驻记忆和项目库。
set "KIMI_VAULT=%~1"
if not defined KIMI_VAULT set /p "KIMI_VAULT=请输入解压后的 Kimi vault 目录: "
node "%~dp0..\lib\import-kimi.js" "%KIMI_VAULT%"
if errorlevel 1 (echo 导入失败。) else (echo 导入完成，请重新启动 DSH 并新建聊天会话。)
pause

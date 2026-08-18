@echo off
setlocal
set "MARK_ROOT=%~dp0"
"%MARK_ROOT%node_modules\.pnpm\electron@43.3.0\node_modules\electron\dist\electron.exe" "%MARK_ROOT%"

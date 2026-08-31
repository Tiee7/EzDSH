@echo off
setlocal
set "APP_ROOT=%~dp0..\.."

if exist "%APP_ROOT%\EzDSH.exe" (
  "%APP_ROOT%\EzDSH.exe" --cli dsh %*
  exit /b %ERRORLEVEL%
)
if exist "%APP_ROOT%\ezdsh.exe" (
  "%APP_ROOT%\ezdsh.exe" --cli dsh %*
  exit /b %ERRORLEVEL%
)

echo EzDSH application executable was not found near %~dp0 1>&2
exit /b 1

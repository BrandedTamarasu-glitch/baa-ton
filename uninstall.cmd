@echo off
rem Baa-ton uninstaller bootstrap -- Windows CMD.
rem Downloads the PowerShell uninstaller, forwards its arguments, and removes
rem the temporary script afterward.
setlocal
where powershell >nul 2>nul || (echo error: Windows PowerShell is required & exit /b 1)
where curl >nul 2>nul || (echo error: curl is required & exit /b 1)

set "SCRIPT=%TEMP%\baa-ton-uninstall-%RANDOM%.ps1"
curl -fsSL https://raw.githubusercontent.com/zachristmas/baa-ton/main/uninstall.ps1 -o "%SCRIPT%"
if errorlevel 1 (
  echo error: could not download the Baa-ton uninstaller
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"
del /q "%SCRIPT%" >nul 2>nul
exit /b %EXIT_CODE%

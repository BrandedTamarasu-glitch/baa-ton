@echo off
rem Baa-ton installer bootstrap -- Windows CMD.
rem Checks prerequisites, then runs the PowerShell installer.
setlocal
where git >nul 2>nul || (echo error: git is required & exit /b 1)
where node >nul 2>nul || (echo error: Node.js 20+ is required & exit /b 1)
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/zachristmas/baa-ton/main/install.ps1 | iex"
